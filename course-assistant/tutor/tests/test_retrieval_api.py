"""Retrieval exposes PDF evidence without a second model call or query history."""

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.test import Client, TestCase, override_settings

from tutor.models import QueryRecord
from tutor.services.errors import RAGError
from tutor.services.index import build_index, clear_index_cache
from tutor.tests.test_api import SOURCES, STATUS
from tutor.tests.test_retrieval import FixtureEmbeddings, write_text_pdf


class RetrievalAPITests(TestCase):
    def post_question(self, payload):
        return self.client.post(
            "/api/retrieve/", json.dumps(payload), content_type="application/json"
        )

    @patch("tutor.services.qa.requests.post")
    @patch("tutor.views.answer_question")
    @patch("tutor.views.retrieve", return_value=SOURCES)
    def test_returns_only_passages_with_no_answer_or_history(self, retrieve, answer, model):
        with patch.object(QueryRecord.objects, "create") as write_history:
            response = self.post_question({"question": "  队列是什么？  "})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"question": "队列是什么？", "sources": SOURCES})
        retrieve.assert_called_once_with("队列是什么？")
        answer.assert_not_called()
        model.assert_not_called()
        write_history.assert_not_called()
        self.assertFalse(QueryRecord.objects.exists())

    @patch("tutor.views.retrieve", return_value=[])
    def test_no_match_is_an_empty_source_list(self, retrieve):
        response = self.post_question({"question": "知识库里没有的话题"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"question": "知识库里没有的话题", "sources": []})
        self.assertFalse(QueryRecord.objects.exists())

    @patch("tutor.views.retrieve")
    def test_invalid_json_and_questions_never_reach_retrieval(self, retrieve):
        for payload in ({}, {"question": ""}, {"question": " \n "},
                        {"question": None}, {"question": 5},
                        {"question": ["队列"]}, {"question": "a" * 2001}):
            with self.subTest(payload=payload):
                self.assertEqual(self.post_question(payload).status_code, 400)
        for body in ('{"question":', 'null', '[]', '"队列"'):
            with self.subTest(body=body):
                response = self.client.post(
                    "/api/retrieve/", body, content_type="application/json"
                )
                self.assertEqual(response.status_code, 400)
        self.assertEqual(self.client.get("/api/retrieve/").status_code, 405)
        self.assertEqual(self.client.post("/api/retrieve/", {"question": "队列"}).status_code, 415)
        retrieve.assert_not_called()

    @patch("tutor.views.retrieve")
    @patch("tutor.views.answer_question")
    def test_both_json_endpoints_enforce_the_same_actual_body_limit(self, answer, retrieve):
        payload = json.dumps({"question": "队列", "padding": "x" * (16 * 1024)})
        for path in ("/api/ask/", "/api/retrieve/"):
            with self.subTest(path=path):
                response = self.client.post(path, payload, content_type="application/json")
                self.assertEqual(response.status_code, 413)
                self.assertEqual(response.json()["error"]["code"], "request_too_large")
        answer.assert_not_called()
        retrieve.assert_not_called()

    @patch("tutor.views.get_status", return_value=STATUS)
    @patch("tutor.views.retrieve", return_value=SOURCES)
    def test_django_csrf_protection_requires_the_service_session_token(self, retrieve, _):
        browser = Client(enforce_csrf_checks=True)
        browser.get("/")
        payload = json.dumps({"question": "队列是什么？"})
        rejected = browser.post("/api/retrieve/", payload, content_type="application/json")
        self.assertEqual(rejected.status_code, 403)
        self.assertEqual(rejected.json()["error"]["code"], "csrf_failed")
        retrieve.assert_not_called()
        accepted = browser.post(
            "/api/retrieve/", payload, content_type="application/json",
            HTTP_X_CSRFTOKEN=browser.cookies["csrftoken"].value,
        )
        self.assertEqual(accepted.status_code, 200)
        retrieve.assert_called_once_with("队列是什么？")

    @patch("tutor.views.retrieve")
    def test_missing_index_and_unexpected_failures_are_safe(self, retrieve):
        retrieve.side_effect = RAGError("index_missing", "请先建立知识库索引。")
        response = self.post_question({"question": "队列是什么？"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "index_missing")
        retrieve.side_effect = RuntimeError("SECRET_API_KEY_TOKEN /private/index")
        with self.assertLogs("tutor.views", level="ERROR"):
            response = self.post_question({"question": "队列是什么？"})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("SECRET_API_KEY_TOKEN", response.content.decode())
        self.assertNotIn("/private/index", response.content.decode())
        self.assertFalse(QueryRecord.objects.exists())


class PersistedRetrievalEndpointTests(TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        knowledge = root / "knowledge"
        knowledge.mkdir()
        write_text_pdf(knowledge / "course.pdf", [
            "A queue follows FIFO. Enqueue and dequeue take O(1) time.",
            "",
            "A stack follows LIFO. Push and pop take O(1) time.",
        ])
        configuration = override_settings(
            KNOWLEDGE_DIR=knowledge, RAG_INDEX_DIR=root / "index",
            RAG_EMBEDDING_BACKEND="fastembed", RAG_EMBEDDING_MODEL="test-fixture",
            RAG_CHUNK_SIZE=256, RAG_CHUNK_OVERLAP=20,
            RAG_TOP_K=4, RAG_MIN_SCORE=0.45,
            OPENAI_API_KEY="configured-but-must-not-be-used",
            RAG_EMBEDDING_API_KEY="",
        )
        configuration.enable()
        self.addCleanup(configuration.disable)
        provider = patch("tutor.services.index.get_embedding", return_value=FixtureEmbeddings())
        provider.start()
        self.addCleanup(provider.stop)
        clear_index_cache()
        self.addCleanup(clear_index_cache)
        build_index()

    @patch("tutor.services.qa.requests.post")
    @patch("tutor.views.answer_question")
    def test_actual_faiss_evidence_keeps_page_text_and_never_calls_a_model(self, answer, model):
        response = self.client.post(
            "/api/retrieve/", json.dumps({"question": "stack push"}),
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["question"], "stack push")
        self.assertEqual(len(result["sources"]), 1)
        source = result["sources"][0]
        self.assertEqual(source["filename"], "course.pdf")
        self.assertEqual(source["page"], 3)
        self.assertIn("A stack follows LIFO", source["excerpt"])
        self.assertIsInstance(source["score"], float)
        self.assertTrue(source["id"])
        self.assertEqual(set(result), {"question", "sources"})
        answer.assert_not_called()
        model.assert_not_called()
        self.assertFalse(QueryRecord.objects.exists())
