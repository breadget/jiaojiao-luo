"""FastAPI entrypoint for the local-only computer control server."""

from __future__ import annotations

import platform
import secrets
import string
import traceback
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

import actions  # noqa: F401 - explicit import populates the action registry.
from actions.registry import all_actions, startup_self_check
from core import logger
from core.errors import ControlError, ErrorCode, InternalError, http_status_for
from core.executor import run_action
from schemas.action import (
    REQUEST_ID_PATTERN,
    ActionError,
    ActionRequest,
    ActionResponse,
)

APP_VERSION = "0.1.0"
STARTED_AT = logger.now_iso()
_REQUEST_ID_ALPHABET = string.ascii_letters + string.digits


def generate_request_id() -> str:
    suffix = "".join(secrets.choice(_REQUEST_ID_ALPHABET) for _ in range(6))
    return f"req_{suffix}"


def _banner() -> str:
    action_lines = "\n".join(
        f"  - {definition.name} (level={int(definition.level)}, timeout={definition.timeout_s:g}s)"
        for definition in all_actions()
    )
    return (
        "\nComputer Control Server\n"
        f"  version: {APP_VERSION}\n"
        f"  python: {platform.python_version()}\n"
        f"  platform: {platform.platform()}\n"
        "  listen: http://127.0.0.1:8765\n"
        "  allowed actions:\n"
        f"{action_lines}\n"
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    startup_self_check()
    logger.cleanup_old_logs(30)
    print(_banner(), flush=True)
    yield


app = FastAPI(
    title="Computer Control Server",
    version=APP_VERSION,
    lifespan=lifespan,
)


def _standard_error_response(
    *,
    request_id: str,
    action: str,
    error: ControlError,
) -> ActionResponse:
    return ActionResponse(
        requestId=request_id,
        action=action,
        success=False,
        data=None,
        message=error.message,
        error=ActionError(code=error.code.value, detail=error.detail),
        duration_ms=0,
        timestamp=logger.now_iso(),
    )


def _summarize_request_errors(error: RequestValidationError) -> str:
    parts: list[str] = []
    for item in error.errors():
        location = ".".join(
            str(segment) for segment in item.get("loc", ()) if segment != "body"
        )
        parts.append(f"{location or 'body'}: {item.get('msg', 'invalid value')}")
    return "; ".join(parts)


@app.exception_handler(RequestValidationError)
async def request_validation_handler(
    request: Request,
    error: RequestValidationError,
) -> JSONResponse:
    body = error.body if isinstance(error.body, dict) else {}
    raw_request_id = body.get("requestId")
    valid_request_id = (
        raw_request_id
        if isinstance(raw_request_id, str)
        and REQUEST_ID_PATTERN.fullmatch(raw_request_id)
        else generate_request_id()
    )
    action = body.get("action") if isinstance(body.get("action"), str) else ""
    control_error = ControlError(
        ErrorCode.INVALID_PARAMS,
        _summarize_request_errors(error),
        "请求格式无效",
    )
    response = _standard_error_response(
        request_id=valid_request_id,
        action=action,
        error=control_error,
    )
    logger.record(
        request_id=valid_request_id,
        action=action,
        params=body.get("params") if isinstance(body.get("params"), dict) else {},
        level=None,
        status="failed",
        duration_ms=0,
        data=None,
        error=response.error.model_dump(mode="json") if response.error else None,
        source_ip=request.client.host if request.client else "unknown",
        invalid_request_id=raw_request_id is not None
        and raw_request_id != valid_request_id,
        timestamp=response.timestamp,
    )
    return JSONResponse(status_code=422, content=jsonable_encoder(response))


@app.exception_handler(ControlError)
async def control_error_handler(_: Request, error: ControlError) -> JSONResponse:
    response = _standard_error_response(
        request_id=generate_request_id(),
        action="",
        error=error,
    )
    return JSONResponse(
        status_code=http_status_for(error.code),
        content=jsonable_encoder(response),
    )


@app.exception_handler(Exception)
async def unexpected_error_handler(request: Request, _: Exception) -> JSONResponse:
    error = InternalError()
    response = _standard_error_response(
        request_id=generate_request_id(),
        action="",
        error=error,
    )
    logger.record(
        request_id=response.requestId,
        action=f"HTTP {request.method} {request.url.path}",
        params={},
        level=None,
        status="failed",
        duration_ms=0,
        data=None,
        error=response.error.model_dump(mode="json") if response.error else None,
        source_ip=request.client.host if request.client else "unknown",
        traceback_text=traceback.format_exc(),
        timestamp=response.timestamp,
    )
    return JSONResponse(status_code=500, content=jsonable_encoder(response))


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "online",
        "version": APP_VERSION,
        "platform": platform.platform(),
        "python": platform.python_version(),
        "started_at": STARTED_AT,
    }


@app.get("/capabilities")
def capabilities() -> dict[str, Any]:
    return {
        "version": APP_VERSION,
        "actions": [
            {
                "name": definition.name,
                "level": int(definition.level),
                "description": definition.description,
                "params_schema": definition.params_model.model_json_schema(),
                "timeout_s": definition.timeout_s,
                "side_effects": definition.side_effects,
            }
            for definition in all_actions()
        ],
    }


@app.post("/action", response_model=ActionResponse)
def execute_action(
    payload: ActionRequest,
    request: Request,
    response: Response,
) -> ActionResponse:
    request_id = payload.requestId or generate_request_id()
    result = run_action(
        request_id,
        payload.action,
        payload.params,
        source_ip=request.client.host if request.client else "unknown",
        invalid_request_id=payload.invalid_request_id,
    )
    if result.error and result.error.code == ErrorCode.INTERNAL_ERROR.value:
        response.status_code = 500
    return result


if __name__ == "__main__":
    uvicorn.run("app:app", host="127.0.0.1", port=8765)
