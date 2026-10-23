"""Validate the generated ASCII STL files without third-party packages."""

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
STL_DIR = ROOT / "body" / "jiaojiao_bot" / "cad" / "stl"
PARTS = {
    "adapter_frame.stl": ((213.5, 214.5), (149.8, 150.8), (4.5, 5.5)),
    "base_shell.stl": ((213.5, 214.5), (149.5, 150.5), (17.5, 18.5)),
    "logo_badge.stl": ((77.5, 78.5), (17.5, 18.5), (3.5, 4.5)),
    "torso_support.stl": ((49.0, 51.0), (111.0, 113.0), (107.0, 109.0)),
    "chest_shell.stl": ((10.0, 11.0), (85.0, 87.0), (71.0, 73.0)),
    "arm_left.stl": ((8.5, 9.5), (35.0, 37.0), (64.0, 66.0)),
    "arm_right.stl": ((8.5, 9.5), (35.0, 37.0), (64.0, 66.0)),
}


def vertices(path: Path):
    text = path.read_text(encoding="ascii", errors="ignore")
    return [
        tuple(float(value) for value in match)
        for match in re.findall(
            r"\bvertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)",
            text,
        )
    ]


def main() -> int:
    for name, expected in PARTS.items():
        path = STL_DIR / name
        if not path.is_file():
            raise SystemExit(f"missing generated STL: {path}")
        points = vertices(path)
        if not points or len(points) % 3:
            raise SystemExit(f"invalid triangle stream: {path}")
        bounds = tuple(
            (min(point[index] for point in points), max(point[index] for point in points))
            for index in range(3)
        )
        spans = tuple(high - low for low, high in bounds)
        for axis, (actual, limits) in enumerate(zip(spans, expected)):
            if not limits[0] <= actual <= limits[1]:
                raise SystemExit(
                    f"{name}: axis {axis} span {actual:.3f} outside {limits}"
                )
        print(f"{name}: {len(points) // 3} triangles, spans "
              f"{tuple(round(span, 3) for span in spans)} mm")
    return 0


if __name__ == "__main__":
    sys.exit(main())
