from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path
from typing import Any

import psutil
import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel, ConfigDict

import core.logger as audit_logger
from actions import registry
from actions.registry import register
from app import app
from core.executor import SubprocessCommand, run_action, run_subprocess
from schemas.action import ActionDef, ActionLevel


class NoParams(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TextParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: str


@pytest.fixture
def log_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "logs"
    monkeypatch.setattr(audit_logger, "LOG_DIR", path)
    return path


@pytest.fixture
def client(log_dir: Path) -> Any:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def isolated_registry(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(registry, "_REGISTRY", dict(registry._REGISTRY))


def register_test_action(
    name: str,
    handler: Any,
    *,
    level: ActionLevel = ActionLevel.READ_ONLY,
    timeout_s: float = 1.0,
) -> None:
    register(
        ActionDef(
            name=name,
            level=level,
            description=f"test action {name}",
            params_model=NoParams,
            timeout_s=timeout_s,
            side_effects="none",
            handler=handler,
        )
    )


def latest_log_entry(log_dir: Path) -> dict[str, Any]:
    paths = sorted(log_dir.glob("actions-*.jsonl"))
    assert paths
    lines = paths[-1].read_text(encoding="utf-8").splitlines()
    assert lines
    return json.loads(lines[-1])


def test_health(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "online"
    assert body["version"] == "0.1.0"
    assert body["platform"]
    assert body["python"]
    assert body["started_at"]


def test_python_version_success(client: TestClient) -> None:
    response = client.post("/action", json={"action": "python_version"})
    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"]["output"].startswith("Python ")
    assert body["data"]["implementation"]
    assert body["error"] is None


def test_unknown_action_is_audited_business_failure(
    client: TestClient,
    log_dir: Path,
) -> None:
    response = client.post("/action", json={"action": "does_not_exist"})
    assert response.status_code == 200
    assert response.json()["success"] is False
    assert response.json()["error"]["code"] == "UNKNOWN_ACTION"
    assert latest_log_entry(log_dir)["status"] == "failed"


def test_invalid_action_params(client: TestClient) -> None:
    response = client.post(
        "/action",
        json={"action": "python_version", "params": {"x": 1}},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["error"]["code"] == "INVALID_PARAMS"
    assert "x" in body["error"]["detail"]


def test_reserved_action_can_never_execute(client: TestClient) -> None:
    response = client.post(
        "/action",
        json={"action": "run_command", "params": {"cmd": "whoami"}},
    )
    assert response.status_code == 200
    assert response.json()["success"] is False
    assert response.json()["error"]["code"] == "UNKNOWN_ACTION"


def test_generated_request_id(client: TestClient) -> None:
    body = client.post("/action", json={"action": "python_version"}).json()
    assert re.fullmatch(r"req_[A-Za-z0-9]{6}", body["requestId"])


def test_request_id_is_preserved(client: TestClient) -> None:
    body = client.post(
        "/action",
        json={"requestId": "req_893124", "action": "python_version"},
    ).json()
    assert body["requestId"] == "req_893124"


def test_invalid_request_id_is_replaced_and_marked(
    client: TestClient,
    log_dir: Path,
) -> None:
    body = client.post(
        "/action",
        json={"requestId": "not-valid", "action": "python_version"},
    ).json()
    assert re.fullmatch(r"req_[A-Za-z0-9]{6}", body["requestId"])
    assert latest_log_entry(log_dir)["invalid_request_id"] is True


def test_timeout_stops_the_approved_process(
    tmp_path: Path,
    log_dir: Path,
    isolated_registry: None,
) -> None:
    pid_path = tmp_path / "timed-out.pid"
    child_code = (
        "import os, pathlib, time; "
        f"pathlib.Path({str(pid_path)!r}).write_text(str(os.getpid()), encoding='utf-8'); "
        "time.sleep(5)"
    )
    register_test_action(
        "test_delay",
        lambda _: SubprocessCommand((sys.executable, "-c", child_code)),
        timeout_s=0.2,
    )
    started = time.perf_counter()
    response = run_action("req_timeout", "test_delay", {})
    elapsed = time.perf_counter() - started
    assert response.success is False
    assert response.error is not None
    assert response.error.code == "TIMEOUT"
    assert elapsed < 1.5
    assert pid_path.exists()
    assert not psutil.pid_exists(int(pid_path.read_text(encoding="utf-8")))
    assert latest_log_entry(log_dir)["status"] == "timeout"


def test_log_fields_and_secret_redaction(
    client: TestClient,
    log_dir: Path,
) -> None:
    client.post(
        "/action",
        json={
            "action": "does_not_exist",
            "params": {"apiKey": "do-not-log", "nested": {"password": "secret"}},
        },
    )
    entry = latest_log_entry(log_dir)
    required = {
        "ts",
        "requestId",
        "action",
        "params",
        "level",
        "status",
        "duration_ms",
        "output_size",
        "error",
        "source_ip",
        "pid",
    }
    assert required <= entry.keys()
    assert entry["params"]["apiKey"] == "***"
    assert entry["params"]["nested"]["password"] == "***"


def test_capabilities_exposes_only_day_one_action(client: TestClient) -> None:
    response = client.get("/capabilities")
    assert response.status_code == 200
    actions = response.json()["actions"]
    assert [item["name"] for item in actions] == ["python_version"]
    assert actions[0]["level"] == 0
    assert actions[0]["side_effects"] == "none"
    assert actions[0]["params_schema"]["additionalProperties"] is False


def test_protocol_validation_uses_standard_422_envelope(client: TestClient) -> None:
    response = client.post("/action", json={"params": {}})
    assert response.status_code == 422
    body = response.json()
    assert body["success"] is False
    assert body["error"]["code"] == "INVALID_PARAMS"
    assert "action" in body["error"]["detail"]


def test_extra_request_field_is_rejected(client: TestClient) -> None:
    response = client.post(
        "/action",
        json={"action": "python_version", "command": "whoami"},
    )
    assert response.status_code == 422
    assert response.json()["success"] is False


def test_registration_rejects_reserved_embedded_and_forbidden_actions(
    isolated_registry: None,
) -> None:
    for name in ("run_command", "safe_run_command_v2"):
        with pytest.raises(ValueError, match="reserved action name"):
            register_test_action(name, lambda _: {})
    with pytest.raises(ValueError, match="forbidden action"):
        register_test_action(
            "test_forbidden",
            lambda _: {},
            level=ActionLevel.FORBIDDEN,
        )


def test_string_parameter_defense_runs_before_the_handler(
    log_dir: Path,
    isolated_registry: None,
) -> None:
    called = False

    def unsafe_if_called(_: TextParams) -> dict[str, str]:
        nonlocal called
        called = True
        return {"output": "unexpected"}

    register(
        ActionDef(
            name="test_text_input",
            level=ActionLevel.READ_ONLY,
            description="test string defense",
            params_model=TextParams,
            timeout_s=1,
            side_effects="none",
            handler=unsafe_if_called,
        )
    )
    response = run_action(
        "req_string_defense",
        "test_text_input",
        {"value": "safe-looking; whoami"},
    )
    assert response.success is False
    assert response.error is not None
    assert response.error.code == "INVALID_PARAMS"
    assert "params.value" in response.error.detail
    assert called is False


def test_high_risk_action_requires_confirmation(
    log_dir: Path,
    isolated_registry: None,
) -> None:
    register_test_action(
        "test_high_risk",
        lambda _: {"output": "should not run"},
        level=ActionLevel.HIGH_RISK,
    )
    response = run_action("req_denied", "test_high_risk", {})
    assert response.success is False
    assert response.error is not None
    assert response.error.code == "PERMISSION_DENIED"
    assert latest_log_entry(log_dir)["status"] == "denied"


def test_long_process_output_is_truncated() -> None:
    result = run_subprocess(
        SubprocessCommand((sys.executable, "-c", "print('x' * 9000, end='')")),
        timeout_s=2,
    )
    assert result["stdout"].startswith("x" * 8_000)
    assert "...[truncated 1000 chars]" in result["stdout"]


def test_nonzero_process_exit_is_normalized(
    log_dir: Path,
    isolated_registry: None,
) -> None:
    register_test_action(
        "test_failure",
        lambda _: SubprocessCommand(
            (
                sys.executable,
                "-c",
                "import sys; print('no', file=sys.stderr); sys.exit(7)",
            )
        ),
    )
    response = run_action("req_failure", "test_failure", {})
    assert response.success is False
    assert response.error is not None
    assert response.error.code == "EXEC_FAILED"


def test_internal_exception_returns_500_without_traceback(
    client: TestClient,
    isolated_registry: None,
) -> None:
    def fail(_: NoParams) -> dict[str, str]:
        raise RuntimeError("private /machine/path should stay internal")

    register_test_action("test_internal_failure", fail)
    response = client.post("/action", json={"action": "test_internal_failure"})
    assert response.status_code == 500
    serialized = response.text
    assert response.json()["error"]["code"] == "INTERNAL_ERROR"
    assert "/machine/path" not in serialized
    assert "Traceback" not in serialized


def test_audit_write_failure_does_not_change_action_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    not_a_directory = tmp_path / "blocked"
    not_a_directory.write_text("file", encoding="utf-8")
    monkeypatch.setattr(audit_logger, "LOG_DIR", not_a_directory)
    response = run_action("req_log_failure", "python_version", {})
    assert response.success is True
