"""Layered action lookup, parameter validation, and authorization."""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

from actions.registry import get
from core.errors import ForbiddenAction, InvalidParams, PermissionDenied, UnknownAction
from schemas.action import ACTION_NAME_PATTERN, ActionDef, ActionLevel

MAX_AUTO_LEVEL = ActionLevel.LOW_RISK
_ACTION_NAME_RE = re.compile(ACTION_NAME_PATTERN)
_FORBIDDEN_STRING_FRAGMENTS = ("\n", "\r", ";", "|", "&", "`", "$(", ">", "<")


@dataclass(frozen=True)
class AuthorizationContext:
    confirmed: bool = False


def _format_validation_error(error: ValidationError) -> str:
    parts: list[str] = []
    for item in error.errors(include_url=False, include_input=False):
        location = ".".join(str(segment) for segment in item.get("loc", ())) or "params"
        parts.append(f"{location}: {item.get('msg', 'invalid value')}")
    return "; ".join(parts)


def _string_values(value: Any, path: str = "params") -> Iterator[tuple[str, str]]:
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        for key, child in value.items():
            yield from _string_values(child, f"{path}.{key}")
    elif isinstance(value, (list, tuple, set)):
        for index, child in enumerate(value):
            yield from _string_values(child, f"{path}[{index}]")


def _defend_string_params(params: BaseModel) -> None:
    serialized = params.model_dump(mode="python")
    for path, value in _string_values(serialized):
        for fragment in _FORBIDDEN_STRING_FRAGMENTS:
            if fragment in value:
                raise InvalidParams(f"{path}: contains forbidden fragment {fragment!r}")


def validate(
    action_name: str, raw_params: dict[str, Any]
) -> tuple[ActionDef, BaseModel]:
    if _ACTION_NAME_RE.fullmatch(action_name) is None or len(action_name) > 64:
        raise InvalidParams("action: must match ^[a-z0-9_.]{1,64}$")

    definition = get(action_name)
    if definition is None:
        raise UnknownAction(action_name)
    if not isinstance(raw_params, dict):
        raise InvalidParams("params: must be an object")

    try:
        params = definition.params_model.model_validate(raw_params)
    except ValidationError as error:
        raise InvalidParams(_format_validation_error(error)) from error

    _defend_string_params(params)
    return definition, params


def authorize(
    definition: ActionDef,
    context: AuthorizationContext | None = None,
) -> None:
    context = context or AuthorizationContext()
    if definition.level == ActionLevel.FORBIDDEN:
        raise ForbiddenAction(f"action '{definition.name}' is forbidden")
    if definition.level > MAX_AUTO_LEVEL and not context.confirmed:
        raise PermissionDenied(
            f"action '{definition.name}' requires explicit confirmation at level "
            f"{int(definition.level)}"
        )


def resolve_allowed_path(path: str | Path, allowed_base: str | Path) -> Path:
    """Resolve a future path parameter and keep it beneath its approved root."""

    base = Path(allowed_base).resolve()
    candidate = (
        (base / path).resolve()
        if not Path(path).is_absolute()
        else Path(path).resolve()
    )
    try:
        candidate.relative_to(base)
    except ValueError as error:
        raise InvalidParams(
            "path: resolves outside the allowed base directory"
        ) from error
    return candidate
