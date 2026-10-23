"""Best-effort, append-only JSONL audit logging."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parents[1]
LOG_DIR = BASE_DIR / "logs"
_SENSITIVE_KEY_FRAGMENTS = ("token", "password", "key", "secret")


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def redact(value: Any, field_name: str = "") -> Any:
    if field_name and any(
        fragment in field_name.casefold() for fragment in _SENSITIVE_KEY_FRAGMENTS
    ):
        return "***"
    if isinstance(value, dict):
        return {str(key): redact(child, str(key)) for key, child in value.items()}
    if isinstance(value, list):
        return [redact(child) for child in value]
    if isinstance(value, tuple):
        return [redact(child) for child in value]
    return value


def _output_size(data: dict[str, Any] | None) -> int:
    if not data:
        return 0
    output = data.get("output")
    if isinstance(output, str):
        return len(output.encode("utf-8"))
    return len(json.dumps(data, ensure_ascii=False, default=str).encode("utf-8"))


def record(
    *,
    request_id: str,
    action: str,
    params: dict[str, Any],
    level: int | None,
    status: str,
    duration_ms: int,
    data: dict[str, Any] | None,
    error: dict[str, Any] | None,
    source_ip: str,
    invalid_request_id: bool = False,
    traceback_text: str | None = None,
    timestamp: str | None = None,
) -> None:
    """Append one audit event; failures are reported to stderr and swallowed."""

    timestamp = timestamp or now_iso()
    entry: dict[str, Any] = {
        "ts": timestamp,
        "requestId": request_id,
        "action": action,
        "params": redact(params),
        "level": level,
        "status": status,
        "duration_ms": duration_ms,
        "output_size": _output_size(data),
        "error": redact(error),
        "source_ip": source_ip,
        "pid": os.getpid(),
    }
    if invalid_request_id:
        entry["invalid_request_id"] = True
    if traceback_text:
        entry["traceback"] = traceback_text

    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        date_part = datetime.fromisoformat(timestamp).date().isoformat()
        path = LOG_DIR / f"actions-{date_part}.jsonl"
        with path.open("a", encoding="utf-8", buffering=1) as handle:
            handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")))
            handle.write("\n")
    except Exception as log_error:  # noqa: BLE001 - logging is deliberately best effort.
        print(f"audit log write failed: {log_error}", file=sys.stderr)


def cleanup_old_logs(days: int = 30) -> None:
    if days < 1:
        raise ValueError("days must be at least 1")
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        cutoff = datetime.now().astimezone() - timedelta(days=days)
        for path in LOG_DIR.glob("actions-*.jsonl"):
            modified = datetime.fromtimestamp(path.stat().st_mtime).astimezone()
            if modified < cutoff:
                path.unlink()
    except Exception as cleanup_error:  # noqa: BLE001 - startup must survive log cleanup.
        print(f"audit log cleanup failed: {cleanup_error}", file=sys.stderr)
