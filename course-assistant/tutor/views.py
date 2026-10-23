import json
import logging

from django.conf import settings
from django.core.exceptions import RequestDataTooBig
from django.http import JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import ensure_csrf_cookie

from .models import QueryRecord
from .services.rag import RAGError, answer_question, get_status

logger = logging.getLogger(__name__)
MAX_QUESTION_LENGTH = 2000


def _error(code, message, status_code=400):
    return JsonResponse({"error": {"code": code, "message": message}}, status=status_code)


def _validate_question(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("请输入要问的课程问题。")
    question = value.strip()
    if len(question) > MAX_QUESTION_LENGTH:
        raise ValueError(f"问题请控制在 {MAX_QUESTION_LENGTH} 字以内。")
    return question


def _answer(question):
    result = answer_question(question)
    result = {"question": question, **result}
    QueryRecord.objects.create(
        question=question,
        answer=result["answer"],
        sources=result["sources"],
        mode=result["mode"],
    )
    return result


@ensure_csrf_cookie
def home(request):
    if request.method not in {"GET", "POST"}:
        return _error("method_not_allowed", "请使用 GET 查看页面，或 POST 提交问题。", 405)
    context = {}
    if request.method == "POST":
        try:
            context["question"] = request.POST.get("question", "")
            question = _validate_question(context["question"])
            context["result"] = _answer(question)
            context["question"] = ""
        except (ValueError, RAGError) as exc:
            context["error"] = str(exc)
        except Exception:
            logger.exception("Course question failed")
            context["error"] = "暂时无法完成问答，请稍后重试；若持续失败，请检查服务配置。"
    return render(request, "tutor/index.html", context)


def status(request):
    if request.method != "GET":
        return _error("method_not_allowed", "请使用 GET 查询知识库状态。", 405)
    try:
        result = get_status()
        result["llm_configured"] = bool(settings.OPENAI_API_KEY.strip())
        return JsonResponse(result)
    except RAGError as exc:
        return _error(exc.code, str(exc), 503)
    except Exception:
        logger.exception("Knowledge status failed")
        return _error("status_unavailable", "暂时无法读取知识库状态，请检查索引后重试。", 503)


def ask(request):
    if request.method != "POST":
        return _error("method_not_allowed", "请使用 POST 提交问题。", 405)
    if request.content_type != "application/json":
        return _error("unsupported_media_type", "请求内容必须为 JSON。", 415)
    try:
        body = json.loads(request.body)
        if not isinstance(body, dict):
            return _error("invalid_request", "请求必须是包含 question 的 JSON 对象。")
        question = _validate_question(body.get("question"))
    except RequestDataTooBig:
        return _error("request_too_large", "请求过大，请缩短问题后重试。", 413)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _error("invalid_json", "JSON 格式有误，请重新提交。")
    except ValueError as exc:
        return _error("invalid_question", str(exc))
    try:
        return JsonResponse(_answer(question))
    except RAGError as exc:
        return _error(exc.code, str(exc), 503)
    except Exception:
        logger.exception("Course question failed")
        return _error("service_unavailable", "暂时无法完成问答，请稍后重试；若持续失败，请检查服务配置。", 503)


def csrf_failure(request, reason=""):
    if request.path.startswith("/api/"):
        return _error("csrf_failed", "页面已失效，请刷新后重新提问。", 403)
    return render(request, "tutor/index.html", {"error": "页面已失效，请刷新后重新提问。"}, status=403)
