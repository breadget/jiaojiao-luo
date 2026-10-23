"""Day 1's only registered capability."""

from __future__ import annotations

import platform
import sys

from pydantic import BaseModel, ConfigDict

from actions.registry import register
from schemas.action import ActionDef, ActionLevel


class PythonVersionParams(BaseModel):
    model_config = ConfigDict(extra="forbid")


def python_version(_: PythonVersionParams) -> dict[str, str]:
    version = platform.python_version()
    return {
        "output": f"Python {version}",
        "version": version,
        "implementation": platform.python_implementation(),
        "executable": sys.executable,
    }


register(
    ActionDef(
        name="python_version",
        level=ActionLevel.READ_ONLY,
        description="返回本机 Python 版本",
        params_model=PythonVersionParams,
        timeout_s=5.0,
        side_effects="none",
        handler=python_version,
    )
)
