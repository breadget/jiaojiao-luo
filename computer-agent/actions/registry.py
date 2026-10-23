"""The single, code-defined allowlist of executable actions."""

from __future__ import annotations

from core.errors import is_reserved
from schemas.action import ActionDef, ActionLevel

_REGISTRY: dict[str, ActionDef] = {}


def register(definition: ActionDef) -> ActionDef:
    if definition.name in _REGISTRY:
        raise ValueError(f"duplicate action: {definition.name}")
    if definition.level == ActionLevel.FORBIDDEN:
        raise ValueError(f"forbidden action cannot be registered: {definition.name}")
    if is_reserved(definition.name):
        raise ValueError(f"reserved action name: {definition.name}")

    _REGISTRY[definition.name] = definition
    return definition


def get(action_name: str) -> ActionDef | None:
    return _REGISTRY.get(action_name)


def all_actions() -> list[ActionDef]:
    return sorted(_REGISTRY.values(), key=lambda definition: definition.name)


def registered_names() -> list[str]:
    return [definition.name for definition in all_actions()]


def startup_self_check() -> None:
    definitions = all_actions()
    if not definitions:
        raise RuntimeError("action registry is empty")

    for definition in definitions:
        if definition.level == ActionLevel.FORBIDDEN:
            raise RuntimeError(f"forbidden action is registered: {definition.name}")
        if is_reserved(definition.name):
            raise RuntimeError(f"reserved action is registered: {definition.name}")
