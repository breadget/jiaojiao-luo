"""Central error vocabulary for API responses, execution, and audit logs."""

from __future__ import annotations

from enum import Enum


class ErrorCode(str, Enum):
    UNKNOWN_ACTION = "UNKNOWN_ACTION"
    INVALID_PARAMS = "INVALID_PARAMS"
    PERMISSION_DENIED = "PERMISSION_DENIED"
    FORBIDDEN_ACTION = "FORBIDDEN_ACTION"
    TIMEOUT = "TIMEOUT"
    EXEC_FAILED = "EXEC_FAILED"
    NOT_FOUND = "NOT_FOUND"
    INTERNAL_ERROR = "INTERNAL_ERROR"


HTTP_STATUS = {ErrorCode.INTERNAL_ERROR: 500}

RESERVED_ACTION_NAMES = frozenset(
    {
        "run_command",
        "exec",
        "shell",
        "cmd",
        "powershell",
        "bash",
        "run_shell",
        "system",
        "raw_exec",
        "eval",
        "python_exec",
        "delete_file",
        "format_disk",
        "regedit",
        "set_acl",
        "stop_service",
    }
)


def is_reserved(name: str) -> bool:
    """Reject exact and embedded reserved names at registration time."""

    normalized = name.casefold()
    return any(reserved in normalized for reserved in RESERVED_ACTION_NAMES)


class ControlError(Exception):
    def __init__(
        self,
        code: ErrorCode,
        detail: str | None = None,
        message: str | None = None,
    ) -> None:
        self.code = code
        self.detail = detail
        self.message = message or code.value.replace("_", " ").title()
        super().__init__(detail or self.message)


class UnknownAction(ControlError):
    def __init__(self, action_name: str) -> None:
        super().__init__(
            ErrorCode.UNKNOWN_ACTION,
            f"action '{action_name}' is not registered",
            "未知动作",
        )


class InvalidParams(ControlError):
    def __init__(self, detail: str) -> None:
        super().__init__(ErrorCode.INVALID_PARAMS, detail, "参数非法")


class PermissionDenied(ControlError):
    def __init__(self, detail: str) -> None:
        super().__init__(ErrorCode.PERMISSION_DENIED, detail, "权限不足")


class ForbiddenAction(ControlError):
    def __init__(self, detail: str) -> None:
        super().__init__(ErrorCode.FORBIDDEN_ACTION, detail, "禁止的动作")


class ActionTimeout(ControlError):
    def __init__(self, detail: str) -> None:
        super().__init__(ErrorCode.TIMEOUT, detail, "执行超时")


class ExecFailed(ControlError):
    def __init__(self, detail: str) -> None:
        super().__init__(ErrorCode.EXEC_FAILED, detail, "执行失败")


class TargetNotFound(ControlError):
    def __init__(self, detail: str) -> None:
        super().__init__(ErrorCode.NOT_FOUND, detail, "目标不存在")


class InternalError(ControlError):
    def __init__(self, detail: str = "unexpected internal failure") -> None:
        super().__init__(ErrorCode.INTERNAL_ERROR, detail, "内部错误")


def http_status_for(code: ErrorCode) -> int:
    return HTTP_STATUS.get(code, 200)
