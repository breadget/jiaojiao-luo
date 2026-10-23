"""Stable public contracts for structured computer actions."""

from __future__ import annotations

import re
from collections.abc import Callable
from enum import IntEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, model_validator

REQUEST_ID_PATTERN = re.compile(r"^req_[A-Za-z0-9]{1,32}$")
ACTION_NAME_PATTERN = r"^[a-z0-9_.]+$"


class ActionLevel(IntEnum):
    """Permission levels shared by registration and authorization."""

    READ_ONLY = 0
    LOW_RISK = 1
    HIGH_RISK = 2
    FORBIDDEN = 3


class ActionRequest(BaseModel):
    """The only request shape accepted by ``POST /action``.

    An invalid caller-supplied request id is deliberately treated as missing.
    The private flag lets the audit log retain that fact without widening the
    public request schema.
    """

    model_config = ConfigDict(extra="forbid")

    requestId: str | None = Field(default=None, pattern=REQUEST_ID_PATTERN.pattern)
    action: str = Field(min_length=1, max_length=64, pattern=ACTION_NAME_PATTERN)
    params: dict[str, Any] = Field(default_factory=dict)
    _invalid_request_id: bool = PrivateAttr(default=False)

    @model_validator(mode="wrap")
    @classmethod
    def normalize_request_id(cls, value: Any, handler: Callable[[Any], Any]) -> Any:
        invalid_request_id = False
        normalized = value
        if isinstance(value, dict):
            raw_request_id = value.get("requestId")
            if raw_request_id is not None and (
                not isinstance(raw_request_id, str)
                or REQUEST_ID_PATTERN.fullmatch(raw_request_id) is None
            ):
                normalized = dict(value)
                normalized["requestId"] = None
                invalid_request_id = True

        result = handler(normalized)
        result._invalid_request_id = invalid_request_id
        return result

    @property
    def invalid_request_id(self) -> bool:
        return self._invalid_request_id


class ActionError(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    detail: str | None = None


class ActionResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requestId: str
    action: str
    success: bool
    data: dict[str, Any] | None
    message: str
    error: ActionError | None
    duration_ms: int = Field(ge=0)
    timestamp: str


SideEffects = Literal[
    "none",
    "launches_process",
    "terminates_process",
    "writes_file",
]


class ActionDef(BaseModel):
    """A capability contract stored in the in-process allowlist."""

    model_config = ConfigDict(arbitrary_types_allowed=True, frozen=True)

    name: str = Field(min_length=1, max_length=64, pattern=ACTION_NAME_PATTERN)
    level: ActionLevel
    description: str = Field(min_length=1)
    params_model: type[BaseModel]
    timeout_s: float = Field(default=5.0, gt=0, le=60)
    side_effects: SideEffects
    handler: Callable[[BaseModel], object]
