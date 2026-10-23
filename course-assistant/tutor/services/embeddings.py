"""Real embedding providers; initializing one may download a local model."""

from functools import lru_cache
from pathlib import Path

import requests
from django.conf import settings
from langchain_core.embeddings import Embeddings

from .errors import RAGError


def embedding_config() -> dict:
    backend = getattr(settings, "RAG_EMBEDDING_BACKEND", "fastembed").strip().lower()
    model = getattr(settings, "RAG_EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5").strip()
    config = {"backend": backend, "model": model}
    if backend == "openai":
        config["base_url"] = getattr(settings, "RAG_EMBEDDING_BASE_URL", "").rstrip("/")
    return config


class CompatibleEmbeddings(Embeddings):
    """LangChain adapter for a configured OpenAI-compatible embeddings API."""

    def __init__(self, base_url: str, api_key: str, model: str, timeout: int):
        if not base_url or not api_key:
            raise RAGError("embedding_config", "请先配置 Embedding 服务地址和 API Key。")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout = timeout

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        vectors = []
        for offset in range(0, len(texts), 32):
            batch = texts[offset : offset + 32]
            try:
                response = requests.post(
                    f"{self.base_url}/embeddings",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json={"model": self.model, "input": batch},
                    timeout=self.timeout,
                )
                response.raise_for_status()
                data = response.json()["data"]
                ordered = sorted(data, key=lambda item: item["index"])
                if [item["index"] for item in ordered] != list(range(len(batch))):
                    raise ValueError("Missing or duplicated embedding records")
                batch_vectors = [item["embedding"] for item in ordered]
                if not all(isinstance(vector, list) and vector for vector in batch_vectors):
                    raise ValueError("Invalid embedding response")
                vectors.extend(batch_vectors)
            except (requests.RequestException, ValueError, TypeError, KeyError):
                raise RAGError(
                    "embedding_unavailable", "Embedding 服务不可用，请检查服务地址、模型和 API Key。"
                ) from None
        return vectors

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]


@lru_cache(maxsize=2)
def _create_embedding(backend: str, model: str, base_url: str, key: str, cache_dir: str, timeout: int):
    if backend == "openai":
        return CompatibleEmbeddings(base_url, key, model, timeout)
    if backend != "fastembed":
        raise RAGError("embedding_config", "RAG_EMBEDDING_BACKEND 必须是 fastembed 或 openai。")
    try:
        from langchain_community.embeddings import FastEmbedEmbeddings

        return FastEmbedEmbeddings(model_name=model, cache_dir=cache_dir, threads=2)
    except Exception:
        # Provider errors may contain credentials or internal paths; expose only this safe message.
        raise RAGError(
            "embedding_unavailable", "本地语义向量模型尚未就绪，请检查模型名称、网络连接和模型下载缓存。"
        ) from None


def get_embedding() -> Embeddings:
    config = embedding_config()
    # Chat and embedding endpoints may belong to different providers. Never send
    # the chat credential to an independently configured embedding service.
    key = getattr(settings, "RAG_EMBEDDING_API_KEY", "") if config["backend"] == "openai" else ""
    cache_dir = str(Path(settings.RAG_INDEX_DIR).parent / "models")
    return _create_embedding(
        config["backend"],
        config["model"],
        config.get("base_url", ""),
        key,
        cache_dir,
        int(getattr(settings, "RAG_TIMEOUT", 60)),
    )
