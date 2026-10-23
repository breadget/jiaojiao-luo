"""Exercise the web contract without contacting embedding or LLM providers."""

import json
from unittest.mock import patch

from django.test import Client, TestCase, override_settings

from tutor.models import QueryRecord
from tutor.services.errors import RAGError


STATUS = {
    "ready": True,
    "document_count": 1,
    "page_count": 2,
    "chunk_count": 3,
    "documents": [{"name": "课程.pdf", "pages": 2}],
    "llm_configured": False,
}
SOURCES = [
    {
        "id": "chunk-1",
        "filename": "课程.pdf",
        "page": 1,
        "excerpt": "队列遵循先进先出，入队和出队的时间复杂度为 O(1)。",
        "score": 0.9,
    }
]


class QuestionAPITests(TestCase):
    def post_question(self, payload):
        return self.client.post(
            "/api/ask/", json.dumps(payload), content_type="application/json"
        )

    @patch("tutor.views.answer_question")
    def test_success_preserves_sources_and_records_answer(self, answer):
        answer.return_value = {
            "question": "队列的复杂度是多少？",
            "answer": "入队和出队通常是 O(1)。",
            "sources": SOURCES,
            "mode": "retrieval_only",
            "warning": "尚未配置大模型。",
        }

        response = self.post_question({"question": "  队列的复杂度是多少？  "})

        self.assertEqual(response.status_code, 200)
        answer.assert_called_once_with("队列的复杂度是多少？")
        self.assertEqual(response.json(), answer.return_value)
        record = QueryRecord.objects.get()
        self.assertEqual(record.question, "队列的复杂度是多少？")
        self.assertEqual(record.answer, answer.return_value["answer"])
        self.assertEqual(record.sources, SOURCES)
        self.assertEqual(record.mode, "retrieval_only")
        self.assertIsNotNone(record.created_at)

    @patch("tutor.views.answer_question")
    def test_invalid_questions_never_call_provider_or_create_history(self, answer):
        for payload in ({}, {"question": ""}, {"question": " \t\n "},
                        {"question": None}, {"question": 5},
                        {"question": ["队列"]}, {"question": "a" * 2001}):
            with self.subTest(payload=payload):
                response = self.post_question(payload)
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.json())
        answer.assert_not_called()
        self.assertFalse(QueryRecord.objects.exists())

    @patch("tutor.views.answer_question")
    def test_malformed_json_and_non_object_json_are_rejected(self, answer):
        for body in ('{"question":', 'null', '[]', '"队列"'):
            with self.subTest(body=body):
                response = self.client.post(
                    "/api/ask/", body, content_type="application/json"
                )
                self.assertEqual(response.status_code, 400)
                self.assertIn("error", response.json())
        answer.assert_not_called()

    @patch("tutor.views.answer_question")
    def test_non_json_request_does_not_reach_provider(self, answer):
        response = self.client.post("/api/ask/", {"question": "队列是什么？"})
        self.assertIn(response.status_code, (400, 415))
        answer.assert_not_called()

    @patch("tutor.views.answer_question")
    def test_missing_index_has_actionable_service_error(self, answer):
        answer.side_effect = RAGError("index_missing", "请先建立知识库索引。")
        response = self.post_question({"question": "队列是什么？"})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["error"]["code"], "index_missing")
        self.assertIn("请先建立知识库索引", response.json()["error"]["message"])
        self.assertFalse(QueryRecord.objects.exists())

    @patch("tutor.views.answer_question")
    def test_unexpected_failure_does_not_expose_provider_details(self, answer):
        answer.side_effect = RuntimeError("SECRET_API_KEY_TOKEN /private/index/credentials")
        with self.assertLogs("tutor.views", level="ERROR"):
            response = self.post_question({"question": "队列是什么？"})
        self.assertGreaterEqual(response.status_code, 500)
        body = response.content.decode()
        self.assertNotIn("SECRET_API_KEY_TOKEN", body)
        self.assertNotIn("/private/index/credentials", body)
        self.assertFalse(QueryRecord.objects.exists())

    def test_question_endpoint_rejects_get(self):
        self.assertEqual(self.client.get("/api/ask/").status_code, 405)


@override_settings(OPENAI_API_KEY="")
class HomepageAndStatusTests(TestCase):
    @patch("tutor.views.get_status", return_value=STATUS)
    def test_status_reports_document_inventory(self, get_status):
        response = self.client.get("/api/status/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), STATUS)
        get_status.assert_called_once()

    @patch("tutor.views.get_status", return_value=STATUS)
    @patch("tutor.views.answer_question")
    def test_homepage_supplies_csrf_and_protected_json_request_succeeds(self, answer, _):
        browser = Client(enforce_csrf_checks=True)
        answer.return_value = {
            "question": "队列是什么？", "answer": "先进先出。",
            "sources": SOURCES, "mode": "retrieval_only",
        }
        page = browser.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertTemplateUsed(page, "tutor/index.html")
        self.assertIn("csrftoken", browser.cookies)

        body = json.dumps({"question": "队列是什么？"})
        rejected = browser.post("/api/ask/", body, content_type="application/json")
        self.assertEqual(rejected.status_code, 403)
        answer.assert_not_called()

        accepted = browser.post(
            "/api/ask/", body, content_type="application/json",
            HTTP_X_CSRFTOKEN=browser.cookies["csrftoken"].value,
        )
        self.assertEqual(accepted.status_code, 200)
        answer.assert_called_once_with("队列是什么？")
