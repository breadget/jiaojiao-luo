"""PDF ingestion and durable FAISS storage without pickle deserialization."""

import fcntl
import hashlib
import json
import os
import re
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import faiss
import numpy as np
from django.conf import settings
from langchain_community.docstore.in_memory import InMemoryDocstore
from langchain_community.vectorstores import FAISS
from langchain_community.vectorstores.utils import DistanceStrategy
from langchain_core.documents import Document
from langchain_text_splitters import RecursiveCharacterTextSplitter
from pypdf import PdfReader

from .embeddings import embedding_config, get_embedding
from .errors import RAGError

SCHEMA_VERSION = 1
_cache_lock = threading.Lock()
_index_cache = {}


def _paths() -> tuple[Path, Path]:
    return Path(settings.KNOWLEDGE_DIR), Path(settings.RAG_INDEX_DIR)


def _pdf_files() -> list[Path]:
    directory, _ = _paths()
    if not directory.is_dir():
        return []
    return sorted(
        (path for path in directory.iterdir() if path.is_file() and path.suffix.lower() == ".pdf"),
        key=lambda path: path.name,
    )


def _file_record(path: Path, *, include_hash: bool) -> dict:
    stat = path.stat()
    record = {"name": path.name, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}
    if include_hash:
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        record["sha256"] = digest.hexdigest()
    return record


def _configuration() -> dict:
    return {
        "schema_version": SCHEMA_VERSION,
        "embedding": embedding_config(),
        "chunk_size": int(getattr(settings, "RAG_CHUNK_SIZE", 650)),
        "chunk_overlap": int(getattr(settings, "RAG_CHUNK_OVERLAP", 100)),
    }


def _current_generation() -> tuple[Path | None, dict | None]:
    _, index_dir = _paths()
    try:
        generation = (index_dir / "CURRENT").read_text(encoding="ascii").strip()
        if not re.fullmatch(r"[0-9a-f]{32}", generation):
            return None, None
        directory = index_dir / "generations" / generation
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or manifest.get("schema_version") != SCHEMA_VERSION:
            return None, None
        if not (directory / "index.faiss").is_file() or not (directory / "chunks.json").is_file():
            return None, None
        return directory, manifest
    except (OSError, ValueError, TypeError):
        return None, None


def _matches(manifest: dict | None, records: list[dict], *, compare_hash: bool) -> bool:
    if not manifest or manifest.get("configuration") != _configuration():
        return False
    stored = manifest.get("documents", [])
    if len(stored) != len(records) or not records:
        return False
    keys = ("name", "sha256") if compare_hash else ("name", "size", "mtime_ns")
    return all(all(old.get(key) == new.get(key) for key in keys) for old, new in zip(stored, records))


def _status(manifest: dict | None, records: list[dict], *, ready: bool) -> dict:
    config = embedding_config()
    stored_documents = {item["name"]: item for item in (manifest or {}).get("documents", [])}
    return {
        "ready": ready,
        "has_index": bool(manifest),
        "stale": bool(manifest) and not ready,
        "document_count": len(records),
        "page_count": (manifest or {}).get("page_count", 0),
        "chunk_count": (manifest or {}).get("chunk_count", 0),
        "embedding_backend": config["backend"],
        "embedding_model": config["model"],
        "indexed_at": (manifest or {}).get("indexed_at"),
        "documents": [
            {"name": item["name"], "pages": stored_documents.get(item["name"], {}).get("pages")}
            for item in records
        ],
    }


def get_status() -> dict:
    """Inspect small metadata files only; never initialize the embedding model."""
    try:
        records = [_file_record(path, include_hash=False) for path in _pdf_files()]
        _, manifest = _current_generation()
        return _status(manifest, records, ready=_matches(manifest, records, compare_hash=False))
    except OSError:
        raise RAGError("knowledge_unavailable", "无法读取知识库目录，请检查文件访问权限。") from None


def load_pdf_documents(paths: list[Path]) -> tuple[list[Document], list[dict]]:
    """Extract each PDF page independently, preserving original text and page numbers."""
    pages, records = [], []
    for path in paths:
        try:
            record = _file_record(path, include_hash=True)
            reader = PdfReader(str(path))
            if reader.is_encrypted and not reader.decrypt(""):
                raise ValueError("Password-protected PDF")
            record["pages"] = len(reader.pages)
            for number, page in enumerate(reader.pages, start=1):
                text = page.extract_text() or ""
                if text.strip():
                    pages.append(Document(page_content=text, metadata={"source": path.name, "page": number}))
            records.append(record)
        except Exception:
            raise RAGError("pdf_unreadable", f"无法读取 PDF“{path.name}”，请使用可提取文本且未加密的文件。") from None
    return pages, records


@contextmanager
def _build_lock(index_dir: Path):
    index_dir.mkdir(parents=True, exist_ok=True)
    with (index_dir / ".build.lock").open("a") as lock:
        deadline = time.monotonic() + max(10, int(getattr(settings, "RAG_TIMEOUT", 60)))
        while True:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise RAGError("index_busy", "知识库正在建立索引，请稍后再试。") from None
                time.sleep(0.1)
        try:
            yield
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def _normalized_vectors(vectors, *, expected_count: int) -> np.ndarray:
    try:
        matrix = np.asarray(vectors, dtype=np.float32)
        if matrix.ndim != 2 or matrix.shape[0] != expected_count or matrix.shape[1] < 1:
            raise ValueError("Wrong embedding shape")
        norms = np.linalg.norm(matrix, axis=1)
        if not np.isfinite(matrix).all() or (norms <= 0).any():
            raise ValueError("Invalid embeddings")
        matrix = np.ascontiguousarray(matrix / norms[:, None])
        return matrix
    except (ValueError, TypeError):
        raise RAGError("embedding_unavailable", "Embedding 服务返回了无效的语义向量，请检查模型配置。") from None


def _write_json(path: Path, value):
    with path.open("w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())


def build_index(force: bool = False) -> dict:
    """Rebuild only when PDF content or the embedding/splitting configuration changes."""
    _, index_dir = _paths()
    generation_dir = None
    try:
        with _build_lock(index_dir):
            paths = _pdf_files()
            if not paths:
                raise RAGError("knowledge_missing", "knowledge 目录中还没有 PDF，请先放入课程知识库文档。")
            records = [_file_record(path, include_hash=True) for path in paths]
            _, manifest = _current_generation()
            if not force and _matches(manifest, records, compare_hash=True):
                # A file may be copied or touched without changing its contents.
                # Refresh only its stat metadata so the cheap status check remains accurate.
                if not _matches(manifest, records, compare_hash=False):
                    directory, _ = _current_generation()
                    updated = dict(manifest)
                    updated["documents"] = [
                        {**old, **new} for old, new in zip(manifest["documents"], records)
                    ]
                    temporary_manifest = directory / f"manifest.{uuid.uuid4().hex}.tmp"
                    _write_json(temporary_manifest, updated)
                    os.replace(temporary_manifest, directory / "manifest.json")
                    manifest = updated
                return _status(manifest, records, ready=True)

            config = _configuration()
            if config["chunk_size"] < 1 or not 0 <= config["chunk_overlap"] < config["chunk_size"]:
                raise RAGError("index_config", "切分长度必须为正数，重叠长度必须小于切分长度。")
            page_documents, records = load_pdf_documents(paths)
            if not page_documents:
                raise RAGError("empty_knowledge", "PDF 中没有可提取的文本；扫描件需要先进行 OCR。")
            splitter = RecursiveCharacterTextSplitter(
                chunk_size=config["chunk_size"],
                chunk_overlap=config["chunk_overlap"],
                separators=["\n\n", "\n", "。", "；", "，", " ", ""],
                add_start_index=True,
                strip_whitespace=False,
            )
            chunks = splitter.split_documents(page_documents)
            chunks = [chunk for chunk in chunks if chunk.page_content.strip()]
            embedding = get_embedding()
            try:
                vectors = _normalized_vectors(
                    embedding.embed_documents([chunk.page_content for chunk in chunks]),
                    expected_count=len(chunks),
                )
            except RAGError:
                raise
            except Exception:
                raise RAGError("embedding_unavailable", "无法生成文档语义向量，请检查 Embedding 模型或服务。") from None
            index = faiss.IndexFlatIP(vectors.shape[1])
            index.add(vectors)
            stored_chunks = []
            for chunk in chunks:
                identifier = hashlib.sha256(
                    f"{chunk.metadata['source']}\0{chunk.metadata['page']}\0"
                    f"{chunk.metadata['start_index']}\0{chunk.page_content}".encode("utf-8")
                ).hexdigest()[:24]
                stored_chunks.append(
                    {"id": identifier, "text": chunk.page_content, "metadata": chunk.metadata}
                )
            manifest = {
                "schema_version": SCHEMA_VERSION,
                "configuration": config,
                "documents": records,
                "document_count": len(records),
                "page_count": sum(record["pages"] for record in records),
                "chunk_count": len(chunks),
                "dimension": vectors.shape[1],
                "indexed_at": datetime.now(timezone.utc).isoformat(),
            }
            # Readers use CURRENT, which is switched only after every file has been written.
            generation = uuid.uuid4().hex
            generation_dir = index_dir / "generations" / generation
            generation_dir.mkdir(parents=True)
            faiss.write_index(index, str(generation_dir / "index.faiss"))
            with (generation_dir / "index.faiss").open("rb") as stream:
                os.fsync(stream.fileno())
            _write_json(generation_dir / "chunks.json", stored_chunks)
            _write_json(generation_dir / "manifest.json", manifest)
            pointer = index_dir / f"CURRENT.{generation}.tmp"
            with pointer.open("w", encoding="ascii") as stream:
                stream.write(generation)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(pointer, index_dir / "CURRENT")
            clear_index_cache()
            return _status(manifest, records, ready=True)
    except RAGError:
        if generation_dir is not None:
            shutil.rmtree(generation_dir, ignore_errors=True)
        raise
    except Exception:
        if generation_dir is not None:
            shutil.rmtree(generation_dir, ignore_errors=True)
        raise RAGError("index_failed", "知识库索引建立失败，请检查文档、模型配置和目录访问权限。") from None


def clear_index_cache():
    with _cache_lock:
        _index_cache.clear()


def _load_vectorstore(directory: Path, manifest: dict, embedding) -> FAISS:
    cache_key = (str(directory.resolve()), id(embedding))
    with _cache_lock:
        if cache_key in _index_cache:
            return _index_cache[cache_key]
        try:
            records = json.loads((directory / "chunks.json").read_text(encoding="utf-8"))
            index = faiss.read_index(str(directory / "index.faiss"))
            if len(records) != index.ntotal or index.d != manifest["dimension"]:
                raise ValueError("Index and document metadata disagree")
            identifiers = [item["id"] for item in records]
            if len(set(identifiers)) != len(identifiers):
                raise ValueError("Duplicated chunk IDs")
            documents = {
                item["id"]: Document(page_content=item["text"], metadata={**item["metadata"], "id": item["id"]})
                for item in records
            }
            store = FAISS(
                embedding_function=embedding,
                index=index,
                docstore=InMemoryDocstore(documents),
                index_to_docstore_id=dict(enumerate(identifiers)),
                distance_strategy=DistanceStrategy.MAX_INNER_PRODUCT,
            )
            # Keep only the current generation in memory; prior generations remain on disk
            # so in-flight readers in other processes can finish safely.
            _index_cache.clear()
            _index_cache[cache_key] = store
            return store
        except Exception:
            raise RAGError("index_invalid", "知识库索引损坏，请运行 index_knowledge --force 重新建立。") from None


def retrieve(question: str, top_k: int | None = None) -> list[dict]:
    build_index()
    directory, manifest = _current_generation()
    if directory is None:
        raise RAGError("index_invalid", "知识库索引不可用，请重新建立。")
    embedding = get_embedding()
    store = _load_vectorstore(directory, manifest, embedding)
    try:
        vector = _normalized_vectors([embedding.embed_query(question)], expected_count=1)[0]
        if len(vector) != store.index.d:
            raise RAGError("embedding_unavailable", "问题向量与索引维度不一致，请检查模型并重建索引。")
        count = max(1, min(int(top_k or getattr(settings, "RAG_TOP_K", 4)), 20))
        matches = store.similarity_search_with_score_by_vector(vector.tolist(), k=count)
    except RAGError:
        raise
    except Exception:
        raise RAGError("embedding_unavailable", "无法检索问题的语义向量，请检查 Embedding 模型或服务。") from None
    threshold = float(getattr(settings, "RAG_MIN_SCORE", 0.45))
    return [
        {
            "id": document.metadata["id"],
            "filename": document.metadata["source"],
            "page": document.metadata["page"],
            "excerpt": document.page_content,
            "score": round(float(score), 4),
        }
        for document, score in sorted(matches, key=lambda item: item[1], reverse=True)
        if float(score) >= threshold
    ]
