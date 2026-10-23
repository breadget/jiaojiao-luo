"""Validate the remote provider boundary without making HTTP requests."""

from unittest.mock import Mock, patch

from django.test import SimpleTestCase, override_settings

from tutor.services.embeddings import CompatibleEmbeddings, _create_embedding, get_embedding
from tutor.services.errors import RAGError


class CompatibleEmbeddingTests(SimpleTestCase):
    def setUp(self):
        self.provider = CompatibleEmbeddings(
            "https://embedding.example/v1", "private-test-key", "fixture-model", 10
        )

    @patch("tutor.services.embeddings.requests.post")
    def test_provider_order_does_not_change_document_vector_mapping(self, post):
        response = Mock()
        response.json.return_value = {
            "data": [{"index": 1, "embedding": [0.0, 1.0]},
                     {"index": 0, "embedding": [1.0, 0.0]}]
        }
        post.return_value = response

        self.assertEqual(
            self.provider.embed_documents(["queue", "stack"]),
            [[1.0, 0.0], [0.0, 1.0]],
        )

    @patch("tutor.services.embeddings.requests.post")
    def test_missing_duplicated_or_malformed_vectors_fail_safely(self, post):
        invalid_responses = [
            {},
            {"data": None},
            {"data": []},
            {"data": [{"index": 0, "embedding": [1.0, 0.0]}]},
            {"data": [{"index": 0, "embedding": [1.0, 0.0]},
                      {"index": 0, "embedding": [0.0, 1.0]}]},
            {"data": [{"index": 0, "embedding": []},
                      {"index": 1, "embedding": [0.0, 1.0]}]},
        ]
        for body in invalid_responses:
            with self.subTest(body=body):
                response = Mock()
                response.json.return_value = body
                post.return_value = response
                with self.assertRaises(RAGError) as failure:
                    self.provider.embed_documents(["queue", "stack"])
                self.assertEqual(failure.exception.code, "embedding_unavailable")
                self.assertNotIn("private-test-key", failure.exception.message)
                self.assertNotIn("embedding.example", failure.exception.message)

    @override_settings(
        RAG_EMBEDDING_BACKEND="openai", RAG_EMBEDDING_MODEL="fixture-model",
        RAG_EMBEDDING_BASE_URL="https://different-embedding.example/v1",
        RAG_EMBEDDING_API_KEY="", OPENAI_API_KEY="private-chat-key",
    )
    @patch("tutor.services.embeddings.requests.post")
    def test_chat_key_is_not_used_for_separate_embedding_provider(self, post):
        _create_embedding.cache_clear()
        self.addCleanup(_create_embedding.cache_clear)
        with self.assertRaises(RAGError) as failure:
            get_embedding()
        self.assertEqual(failure.exception.code, "embedding_config")
        self.assertNotIn("private-chat-key", failure.exception.message)
        post.assert_not_called()
