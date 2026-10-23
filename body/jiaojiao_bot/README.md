# JiaoJiao-Luo — wheeled humanoid robot

JiaoJiao-Luo keeps the repository's four-wheel OpenBot DIY platform, TT motors, Nano/L298N firmware, Android controller, and stock phone holder. The printable outer shell, torso armor, and arms turn the vehicle-like base into a phone-headed humanoid robot while retaining the original differential-drive interface. The visible product mark is `JiaoJiao-Luo`.

- [Chinese build guide, bill of materials, wiring and assembly](README.zh-CN.md)
- [Parametric OpenSCAD model and STL export script](cad/)
- [Mechanical interface regression tests](tests/)

The adapter is dimensioned from the checked-in `body_top.step`. Run the tests before printing; run `cad/build.ps1` with OpenSCAD available on D: to export the seven printable parts.
