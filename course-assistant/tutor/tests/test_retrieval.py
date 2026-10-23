"""Use genuine PDFs and persisted FAISS data; model vectors are deterministic fixtures."""

import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings
from langchain_core.embeddings import Embeddings
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

from tutor.services.errors import RAGError
from tutor.services.index import (
    build_index, clear_index_cache, get_status, load_pdf_documents, retrieve,
)


def write_text_pdf(path, page_texts):
    """Generate a small text PDF without relying on local fonts or extra libraries."""
    writer = PdfWriter()
    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    })
    font_ref = writer._add_object(font)
    for text in page_texts:
        page = writer.add_blank_page(width=612, height=792)
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref})
        })
        if text:
            escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            stream = DecodedStreamObject()
            stream.set_data(f"BT /F1 12 Tf 40 750 Td ({escaped}) Tj ET".encode("ascii"))
            page[NameObject("/Contents")] = writer._add_object(stream)
    with Path(path).open("wb") as output:
        writer.write(output)


class FixtureEmbeddings(Embeddings):
    """A test-only four-topic embedding; production always uses a real provider."""

    def __init__(self):
        self.document_batches = 0

    @staticmethod
    def vector(text):
        text = text.lower()
        topics = (
            ("queue", "fifo", "enqueue", "dequeue"),
            ("stack", "lifo", "push", "pop"),
            ("graph", "edge", "vertex"),
        )
        matched = [float(any(word in text for word in words)) for words in topics]
        return matched + [0.0 if any(matched) else 1.0]

    def embed_documents(self, texts):
        self.document_batches += 1
        return [self.vector(text) for text in texts]

    def embed_query(self, text):
        return self.vector(text)


class PersistentRetrievalTests(SimpleTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.knowledge = root / "knowledge"
        self.index = root / "index"
        self.knowledge.mkdir()
        self.pdf = self.knowledge / "course.pdf"
        write_text_pdf(self.pdf, [
            "A queue follows FIFO ordering. Enqueue and dequeue take O(1) time.",
            "",  # A blank page must not shift the source page numbers.
            "A stack follows LIFO ordering. Push and pop take O(1) time.",
        ])
        configuration = override_settings(
            KNOWLEDGE_DIR=self.knowledge, RAG_INDEX_DIR=self.index,
            RAG_EMBEDDING_BACKEND="fastembed", RAG_EMBEDDING_MODEL="test-fixture",
            RAG_CHUNK_SIZE=256, RAG_CHUNK_OVERLAP=20,
            RAG_TOP_K=4, RAG_MIN_SCORE=0.45, OPENAI_API_KEY="",
            RAG_EMBEDDING_API_KEY="",
        )
        configuration.enable()
        self.addCleanup(configuration.disable)
        self.embeddings = FixtureEmbeddings()
        provider = patch("tutor.services.index.get_embedding", return_value=self.embeddings)
        provider.start()
        self.addCleanup(provider.stop)
        clear_index_cache()
        self.addCleanup(clear_index_cache)

    def generation(self):
        return (self.index / "CURRENT").read_text(encoding="ascii").strip()

    def test_pdf_page_metadata_preserves_original_page_numbers(self):
        pages, documents = load_pdf_documents([self.pdf])
        self.assertEqual([page.metadata["page"] for page in pages], [1, 3])
        self.assertTrue(all(page.metadata["source"] == "course.pdf" for page in pages))
        self.assertEqual(documents[0]["pages"], 3)
        self.assertIn("queue follows FIFO", pages[0].page_content)
        self.assertEqual(len(documents[0]["sha256"]), 64)

    def test_faiss_reload_preserves_retrieval_source_and_exact_excerpt(self):
        built = build_index()
        self.assertTrue(built["ready"])
        self.assertEqual(built["document_count"], 1)
        self.assertEqual(built["page_count"], 3)
        self.assertEqual(built["chunk_count"], 2)

        initial = retrieve("What does a queue do?")
        self.assertEqual(len(initial), 1)
        self.assertEqual(initial[0]["filename"], "course.pdf")
        self.assertEqual(initial[0]["page"], 1)
        self.assertIn("Enqueue and dequeue take O(1) time.", initial[0]["excerpt"])
        self.assertAlmostEqual(initial[0]["score"], 1.0)

        clear_index_cache()
        reloaded = retrieve("What does a queue do?")
        self.assertEqual(reloaded, initial)
        generation_dir = self.index / "generations" / self.generation()
        self.assertTrue((generation_dir / "index.faiss").is_file())
        self.assertTrue((generation_dir / "chunks.json").is_file())
        self.assertFalse(any(generation_dir.glob("*.pkl")))

    def test_unchanged_documents_and_touch_reuse_persisted_vectors(self):
        build_index()
        original = self.generation()
        batches = self.embeddings.document_batches

        build_index()
        self.assertEqual(self.generation(), original)
        self.assertEqual(self.embeddings.document_batches, batches)

        modified = self.pdf.stat().st_mtime_ns + 1_000_000_000
        os.utime(self.pdf, ns=(modified, modified))
        self.assertFalse(get_status()["ready"])
        self.assertTrue(build_index()["ready"])
        self.assertEqual(self.generation(), original)
        self.assertEqual(self.embeddings.document_batches, batches)

    def test_changed_pdf_replaces_old_vectors_and_source_text(self):
        build_index()
        original = self.generation()
        write_text_pdf(self.pdf, ["UPDATED queue material: FIFO ordering uses enqueue and dequeue."])

        self.assertFalse(get_status()["ready"])
        sources = retrieve("Explain queue FIFO ordering")

        self.assertNotEqual(self.generation(), original)
        self.assertEqual(get_status()["page_count"], 1)
        self.assertEqual(len(sources), 1)
        self.assertIn("UPDATED queue material", sources[0]["excerpt"])
        self.assertNotIn("take O(1)", sources[0]["excerpt"])

    def test_removed_document_cannot_answer_using_obsolete_index(self):
        build_index()
        self.pdf.unlink()

        status = get_status()
        self.assertFalse(status["ready"])
        self.assertEqual(status["document_count"], 0)
        with self.assertRaises(RAGError) as failure:
            retrieve("Explain queue FIFO ordering")
        self.assertEqual(failure.exception.code, "knowledge_missing")

    def test_content_change_with_identical_size_and_timestamp_still_reindexes(self):
        write_text_pdf(self.pdf, ["INITIAL queue material follows FIFO ordering."])
        build_index()
        original = self.generation()
        original_stat = self.pdf.stat()
        write_text_pdf(self.pdf, ["UPDATED queue material follows FIFO ordering."])
        self.assertEqual(self.pdf.stat().st_size, original_stat.st_size)
        os.utime(self.pdf, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))

        sources = retrieve("queue FIFO")

        self.assertNotEqual(self.generation(), original)
        self.assertIn("UPDATED", sources[0]["excerpt"])
        self.assertNotIn("INITIAL", sources[0]["excerpt"])

    def test_unrelated_question_has_no_sources(self):
        build_index()
        self.assertEqual(retrieve("How should I forecast tomorrow's weather?"), [])

    def test_failed_rebuild_keeps_previous_generation_usable(self):
        build_index()
        original = self.generation()
        with patch.object(self.embeddings, "embed_documents", side_effect=RuntimeError("private-key")):
            with self.assertRaises(RAGError) as failure:
                build_index(force=True)
        self.assertNotIn("private-key", failure.exception.message)
        self.assertEqual(self.generation(), original)
        self.assertTrue(get_status()["ready"])
        self.assertIn("FIFO", retrieve("queue")[0]["excerpt"])

    def test_corrupt_stored_metadata_fails_safely_and_force_build_repairs_it(self):
        build_index()
        generation_dir = self.index / "generations" / self.generation()
        (generation_dir / "chunks.json").write_text("invalid-json private-key", encoding="utf-8")
        clear_index_cache()

        with self.assertRaises(RAGError) as failure:
            retrieve("queue")
        self.assertEqual(failure.exception.code, "index_invalid")
        self.assertNotIn("private-key", failure.exception.message)

        build_index(force=True)
        self.assertIn("FIFO", retrieve("queue")[0]["excerpt"])

    def test_status_does_not_load_embedding_model_or_expose_secrets(self):
        with override_settings(OPENAI_API_KEY="private-chat-key", RAG_EMBEDDING_API_KEY="private-vector-key"):
            with patch("tutor.services.index.get_embedding") as provider:
                status = get_status()
        provider.assert_not_called()
        self.assertFalse(status["ready"])
        self.assertEqual(status["documents"], [{"name": "course.pdf", "pages": None}])
        self.assertNotIn("private-chat-key", str(status))
        self.assertNotIn("private-vector-key", str(status))
