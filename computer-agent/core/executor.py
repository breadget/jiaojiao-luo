"""The single validated and audited action execution path."""

from __future__ import annotations

import json
import os
import subprocess
import traceback
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from typing import Any

import psutil
from pydantic import BaseModel

from core import logger
from core.errors import (
    ActionTimeout,
    ControlError,
    ErrorCode,
    ExecFailed,
    InternalError,
    PermissionDenied,
    TargetNotFound,
)
from core.security import AuthorizationContext, authorize, validate
from schemas.action import ActionError, ActionResponse

MAX_OUTPUT_CHARS = 8_000


@dataclass(frozen=True)
class SubprocessCommand:
    """An internal-only argv contract; callers can never submit this shape."""

    argv: Sequence[str]
    cwd: str | Path | None = None
    env: Mapping[str, str] | None = None

    def __post_init__(self) -> None:
        if not self.argv or any(
            not isinstance(part, str) or not part or "\x00" in part
            for part in self.argv
        ):
            raise ValueError("argv must contain non-empty, null-free string arguments")


def truncate_output(value: str | bytes | None, limit: int = MAX_OUTPUT_CHARS) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if len(value) <= limit:
        return value
    omitted = len(value) - limit
    return f"{value[:limit]}\n...[truncated {omitted} chars]"


def _terminate_process_tree(process: psutil.Popen[Any]) -> None:
    """Terminate descendants before the root, then force-kill survivors."""

    processes: list[psutil.Process] = []
    try:
        root = psutil.Process(process.pid)
        descendants = root.children(recursive=True)
        processes.extend(reversed(descendants))
        processes.append(root)  # The root is deliberately terminated last.
    except psutil.Error:
        processes = []

    for item in processes:
        try:
            item.terminate()
        except psutil.Error:
            pass
    _, alive = psutil.wait_procs(processes, timeout=0.3)
    for item in alive:
        try:
            item.kill()
        except psutil.Error:
            pass
    psutil.wait_procs(alive, timeout=0.3)

    try:
        process.kill()
    except (psutil.Error, ProcessLookupError):
        pass
    try:
        process.wait(timeout=0.3)
    except (psutil.Error, subprocess.TimeoutExpired):
        pass


def run_subprocess(command: SubprocessCommand, timeout_s: float) -> dict[str, Any]:
    creation_flags = 0
    if os.name == "nt":
        creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

    try:
        process = psutil.Popen(
            list(command.argv),
            cwd=str(command.cwd) if command.cwd is not None else None,
            env=dict(command.env) if command.env is not None else None,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=creation_flags,
            start_new_session=os.name != "nt",
        )
    except FileNotFoundError as error:
        raise TargetNotFound("approved executable was not found") from error
    except PermissionError as error:
        raise PermissionDenied("approved executable could not be started") from error

    try:
        stdout, stderr = process.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired as error:
        _terminate_process_tree(process)
        raise ActionTimeout(f"action exceeded its {timeout_s:g}s timeout") from error

    stdout = truncate_output(stdout)
    stderr = truncate_output(stderr)
    if process.returncode != 0:
        safe_stderr = stderr.strip()[:500]
        detail = f"approved process exited with code {process.returncode}"
        if safe_stderr:
            detail = f"{detail}: {safe_stderr}"
        raise ExecFailed(detail)

    output = stdout.strip() or stderr.strip()
    return {
        "output": output,
        "raw": stdout,
        "stdout": stdout,
        "stderr": stderr,
        "returncode": process.returncode,
    }


def _normalize_result(result: object) -> dict[str, Any]:
    if isinstance(result, BaseModel):
        return result.model_dump(mode="json")
    if isinstance(result, dict):
        json.dumps(result, ensure_ascii=False)
        return result
    if isinstance(result, str):
        return {"output": result}
    if isinstance(result, list):
        json.dumps(result, ensure_ascii=False)
        return {"items": result}
    if result is None:
        return {}
    raise TypeError(f"unsupported action result type: {type(result).__name__}")


def _duration_ms(started: float) -> int:
    return max(0, round((perf_counter() - started) * 1_000))


def _failure_status(error: ControlError) -> str:
    if error.code == ErrorCode.TIMEOUT:
        return "timeout"
    if error.code in {ErrorCode.PERMISSION_DENIED, ErrorCode.FORBIDDEN_ACTION}:
        return "denied"
    return "failed"


def run_action(
    request_id: str,
    action_name: str,
    params: dict[str, Any],
    *,
    source_ip: str = "127.0.0.1",
    confirmed: bool = False,
    invalid_request_id: bool = False,
) -> ActionResponse:
    started = perf_counter()
    level: int | None = None

    try:
        definition, validated_params = validate(action_name, params)
        level = int(definition.level)
        authorize(definition, AuthorizationContext(confirmed=confirmed))

        raw_result = definition.handler(validated_params)
        if isinstance(raw_result, SubprocessCommand):
            data = run_subprocess(raw_result, definition.timeout_s)
        else:
            data = _normalize_result(raw_result)

        duration_ms = _duration_ms(started)
        timestamp = logger.now_iso()
        response = ActionResponse(
            requestId=request_id,
            action=action_name,
            success=True,
            data=data,
            message="",
            error=None,
            duration_ms=duration_ms,
            timestamp=timestamp,
        )
        logger.record(
            request_id=request_id,
            action=action_name,
            params=params,
            level=level,
            status="success",
            duration_ms=duration_ms,
            data=data,
            error=None,
            source_ip=source_ip,
            invalid_request_id=invalid_request_id,
            timestamp=timestamp,
        )
        return response
    except ControlError as error:
        duration_ms = _duration_ms(started)
        timestamp = logger.now_iso()
        response_error = ActionError(code=error.code.value, detail=error.detail)
        response = ActionResponse(
            requestId=request_id,
            action=action_name,
            success=False,
            data=None,
            message=error.message,
            error=response_error,
            duration_ms=duration_ms,
            timestamp=timestamp,
        )
        logger.record(
            request_id=request_id,
            action=action_name,
            params=params,
            level=level,
            status=_failure_status(error),
            duration_ms=duration_ms,
            data=None,
            error=response_error.model_dump(mode="json"),
            source_ip=source_ip,
            invalid_request_id=invalid_request_id,
            timestamp=timestamp,
        )
        return response
    except Exception:  # noqa: BLE001 - the public contract requires a final safe boundary.
        traceback_text = traceback.format_exc()
        error = InternalError()
        duration_ms = _duration_ms(started)
        timestamp = logger.now_iso()
        response_error = ActionError(code=error.code.value, detail=error.detail)
        response = ActionResponse(
            requestId=request_id,
            action=action_name,
            success=False,
            data=None,
            message=error.message,
            error=response_error,
            duration_ms=duration_ms,
            timestamp=timestamp,
        )
        logger.record(
            request_id=request_id,
            action=action_name,
            params=params,
            level=level,
            status="failed",
            duration_ms=duration_ms,
            data=None,
            error=response_error.model_dump(mode="json"),
            source_ip=source_ip,
            invalid_request_id=invalid_request_id,
            traceback_text=traceback_text,
            timestamp=timestamp,
        )
        return response
