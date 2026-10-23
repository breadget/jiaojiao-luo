import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
DESIGN = ROOT / "body" / "jiaojiao_bot"
STEPS = ROOT / "body" / "diy" / "cad" / "regular_body" / "body_top.step"
SCAD = DESIGN / "cad" / "jiaojiao_bot.scad"


def source_cylinders(path: Path):
    text = path.read_text(encoding="ascii", errors="ignore")
    points = {
        match.group(1): tuple(float(value.strip()) for value in match.group(2).split(","))
        for match in re.finditer(
            r"#(\d+)=CARTESIAN_POINT\('[^']*',\(([^)]*)\)\);", text
        )
    }
    placements = {
        match.group(1): match.group(2)
        for match in re.finditer(
            r"#(\d+)=AXIS2_PLACEMENT_3D\('[^']*',#(\d+),#\d+,#\d+\);", text
        )
    }
    for match in re.finditer(
        r"#(\d+)=CYLINDRICAL_SURFACE\('[^']*',#(\d+),([0-9.]+)\);", text
    ):
        point = points.get(placements.get(match.group(2)))
        if point:
            yield float(match.group(3)), point


class DesignInterfaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # body_top.step uses origin (5, 10); the SCAD assembly is centred there.
        cls.features = [
            (radius, round(point[0] - 5, 3), round(point[1] - 10, 3))
            for radius, point in source_cylinders(STEPS)
        ]

    def test_phone_mount_holes_match_stock_step(self):
        holes = {(x, y) for radius, x, y in self.features if abs(radius - 1.75) < 0.001}
        self.assertIn((-53.5, 0.0), holes)
        self.assertIn((-33.5, 0.0), holes)

    def test_four_corner_fasteners_match_stock_step(self):
        holes = {(x, y) for radius, x, y in self.features if abs(radius - 3.0) < 0.001}
        expected = {
            (-98.0, -71.176), (-98.0, 71.176),
            (98.0, -71.176), (98.0, 71.176),
        }
        self.assertTrue(expected.issubset(holes), f"missing stock mounting points: {expected - holes}")

    def test_scad_has_all_reproducible_exports(self):
        source = SCAD.read_text(encoding="utf-8")
        exports = ("adapter_frame", "base_shell", "logo_badge", "torso_support", "chest_shell", "arm_left", "arm_right")
        for name in exports:
            with self.subTest(part=name):
                self.assertIn(f'part == "{name}"', source)
                self.assertIn(f'"{name}"', (DESIGN / "cad" / "build.ps1").read_text(encoding="utf-8"))

    def test_scad_uses_verified_stock_interface_dimensions(self):
        source = SCAD.read_text(encoding="utf-8")
        for declaration in (
            "frame_outer_x = 103;",
            "corner_x = [-98, 98];",
            "corner_y = [-71.175856, 71.175856];",
            "phone_holes_x = [-53.5, -33.5];",
        ):
            with self.subTest(declaration=declaration):
                self.assertIn(declaration, source)

    def test_stock_assets_used_by_build_exist(self):
        self.assertTrue((ROOT / "body/diy/cad/regular_body/body_bottom.stl").is_file())
        self.assertTrue((ROOT / "body/diy/cad/regular_body/body_top.stl").is_file())
        self.assertTrue((ROOT / "body/phone_mount/phone_mount_bottom.stl").is_file())
        self.assertTrue((ROOT / "body/phone_mount/phone_mount_top.stl").is_file())

    def test_build_script_is_reproducible_on_d_drive(self):
        build = (DESIGN / "cad" / "build.ps1").read_text(encoding="utf-8")
        self.assertIn("D:\\tools\\OpenSCAD-2021.01", build)
        self.assertIn("[switch]$Preview", build)
        self.assertIn("jiaojiao_bot.png", build)

    def test_product_branding_is_jiaojiao_luo(self):
        source = SCAD.read_text(encoding="utf-8")
        self.assertIn('text("JiaoJiao-Luo"', source)
        self.assertIn('part == "logo_badge"', source)


if __name__ == "__main__":
    unittest.main()
