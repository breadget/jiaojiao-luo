# JiaoJiao-Luo：轮式人形机器人

这套改造把 OpenBot 的“车壳”替换成“手机头部 + 封闭式装甲上身 + 四轮底盘”。上身采用后背闭合板、收腰侧护板、凸起胸甲和圆润手臂，底盘、电机、电控、手机支架、固件协议和 Android 应用继续使用仓库现有方案；新增部分只有一套开源参数化 CAD 和安装紧固件。默认方案不要求定制 PCB 或改写电机控制固件。

> 机械基线：仓库 `body/diy/cad/regular_body` 标准底盘 + `body/phone_mount` 手机夹 + `firmware/openbot/openbot.ino` 的 `DIY` 配置。手机后置摄像头朝机器人前方，手机作为机器人的头/视觉单元；左右两组 TT 轮差速转向。

## 目录

- [`cad/jiaojiao_bot.scad`](cad/jiaojiao_bot.scad)：参数化装配模型与七个可打印零件。
- [`cad/build.ps1`](cad/build.ps1)：从同一 CAD 源码批量导出 STL。
- [`tests/test_design_interface.py`](tests/test_design_interface.py)：从上游 STEP 文件复核螺孔坐标，并检查导出清单。

## 设计接口

坐标单位为 mm；CAD 原点放在标准 `body_top.step` 的中心 `(5, 10)`。设计自动化测试直接解析该 STEP 文件中的圆柱面，确认新增适配框使用原有孔位：

| 接口 | CAD 坐标 | 用途 |
|---|---:|---|
| 底盘四角 | `x=±98`, `y=±71.176` | 4 个原有 `body_top` 角部紧固孔 |
| 手机支架 | `(-53.5, 0)`, `(-33.5, 0)` | 原有手机支架两孔，中心距 20 mm |
| 上身支座 | `x=27/57`, `y=±30` | 新增适配框上的 4 个 M3 孔 |

装配预览中底盘轮胎和手机是尺寸近似的示意体；实际装配沿用原项目的 `body_bottom.stl`、`body_top.stl`、四个 TT 电机/轮胎和两件手机夹。上身最大轮廓约 150 mm 宽；适配框约 214 × 150 mm，为 220 × 220 mm 打印平台保留边缘余量。

## 复现步骤

### 1. 准备原项目底盘

按 [`body/diy/README.zh-CN.md`](../diy/README.zh-CN.md) 完成标准 DIY 底盘；保留 `body_bottom`、`body_top`、电池盒、Arduino Nano、L298N、四个 TT 电机/轮胎和两件手机夹。控制器与固件沿用仓库现有版本。

**开始打印前先确认自己的 DIY 底盘与标准 `regular_body` 版本一致。** 适配框孔位基于本仓库 `body/diy/cad/regular_body/body_top.step`，与其他车壳/改版 PCB 底盘的孔位不作假设。

### 2. 导出新增 STL

需要 OpenSCAD 2021.01 或更新版本，以及 PowerShell 5.1+。本次复现使用官方 Windows 便携版，解压在 `D:\tools\OpenSCAD-2021.01`，不使用安装器、不写入系统 PATH；脚本默认读取这个 D 盘路径。若工具放在其他 D 盘目录，可显式传入 `-OpenSCAD`：

```powershell
cd D:\robot
.\body\jiaojiao_bot\cad\build.ps1
# 或：
.\body\jiaojiao_bot\cad\build.ps1 -OpenSCAD 'D:\tools\OpenSCAD-2021.01\openscad-2021.01\openscad.com'
# 同时生成装配预览图：
.\body\jiaojiao_bot\cad\build.ps1 -Preview
```

生成文件在 `body/jiaojiao_bot/cad/stl/`：

| 文件 | 数量 | 建议打印方向 |
|---|---:|---|
| `adapter_frame.stl` | 1 | 平放，框架贴床 |
| `base_shell.stl` | 1 | 平放，底面贴床 |
| `logo_badge.stl` | 2 | 平放，文字朝上；同一 STL 打印两份 |
| `torso_support.stl` | 1 | 底脚贴床；切片器加 6–8 mm brim |
| `chest_shell.stl` | 1 | 平放 |
| `arm_left.stl` / `arm_right.stl` | 各 1 | 平放 |

使用 `-Preview` 时，装配预览生成在 `body/jiaojiao_bot/cad/preview/jiaojiao_bot.png`；预览会加载仓库已有的底盘、手机支架和新增打印件，手机与轮胎为尺寸示意，最终装配仍以实物和 CAD 尺寸复核为准。

打印建议：PLA+/PETG；0.20 mm 层高；4 道壁；填充 25–35%；适配框、外壳和支座用 5 道壁。支座打印时不要旋转成薄边着床。上身支座与底脚为一体，收腰侧护板提供抗弯支撑。打印后先用 M3 螺钉手动试孔；紧配时用 3.2–3.5 mm 钻头修孔，不要强行拧入塑料。

### 3. 新增物料

| 物料 | 数量 | 说明 |
|---|---:|---|
| M3 × 30 螺钉 | 6 | 4 个底盘角孔 + 2 个原手机支架孔；替换原有较短螺钉 |
| M3 × 12 螺钉 | 4 | 上身支座固定到适配框 |
| M3 × 14 螺钉 | 4 | 胸甲面板固定 |
| M3 × 18 螺钉 | 4 | 左右手臂各 2 个固定点 |
| M3 螺母 | 12 | 新增零件对应螺母；底盘原有螺母继续使用 |
| M3 垫片 | 8 | 支座/手臂连接处分散载荷，推荐 |
| 橡胶垫或 TPU 垫 | 4 | 适配框与底盘上盖接触点，抑制振动 |
| VHB 双面胶或薄层环氧胶 | 少量 | 固定两份 `logo_badge`，分别覆盖原 `body_top` 的顶部和外侧旧标识 |

原 OpenBot DIY 电气材料清单继续适用：Arduino Nano、1 块 L298N、4 个 TT 减速电机与轮胎、3 节 18650 电池组及电池盒、USB OTG 线、杜邦线；可选模块仍按原项目接线。电池、电池盒和充电/保护配置按原始电气规格匹配，避免混用不同型号或不同电量的电芯。

### 4. 机械装配

1. 断开电池，拆下 `body_top` 上原来的手机支架和四角螺钉；底盘、马达、电路板与线束保持原样。
2. 将 `adapter_frame` 放在原上盖上：框架内侧朝上身；角孔对齐上盖四角孔，手机孔对齐原来的 20 mm 孔距。中间大开口保留对电池和控制板的检修通道。
3. 将 `base_shell` 套在适配框外缘，四角孔与底盘孔同轴；顶部开口朝上，确保电池和控制板仍能取出。使用 4 个 M3×30 螺钉同时锁紧外壳、适配框和原上盖。
4. 原手机夹仍装在原位置，通过外壳开口、适配框手机孔用另外 2 个 M3×30 螺钉固定。先轻锁，再检查手机夹滑轨没有被外壳压住。
5. 将两份 `logo_badge` 分别对准原 `body_top` 的顶部和外侧旧标识区域，用 VHB 双面胶或薄层环氧胶固定；确认可见面显示 `JiaoJiao-Luo`。
6. 将 `torso_support` 底脚对准适配框中部四孔，用 4 个 M3×12 螺钉和螺母固定；检查收腰侧护板都贴合框架。
7. 将 `chest_shell` 放到支座前侧，对齐 4 个安装孔，以 M3×14 固定。
8. 左右手臂分别对准肩部双孔，每侧使用 2 个 M3×18 螺钉、垫片和螺母。螺钉只需锁紧到手臂没有间隙，避免压裂打印件。
9. 装回手机。后置摄像头朝前，手机夹弹簧/橡皮筋照原项目方式固定。检查上身、外壳、线束、手机和轮胎在全方向转动/俯仰时互不干涉。

### 5. 固件、应用与首次行驶

`firmware/openbot/openbot.ino` 默认 `#define OPENBOT DIY`，对应 Arduino Nano 和 DIY 电机引脚。使用 Arduino IDE 按 [`firmware/README.zh-CN.md`](../../firmware/README.zh-CN.md) 编译并烧录；已有 DIY 底盘无需切换 `DIY_ESP32`。安装/构建手机端应用按 [`android/README.zh-CN.md`](../../android/README.zh-CN.md) 操作，USB OTG 连接 MCU 后由原控制器或应用发出左右轮命令。

首次测试顺序：

1. **架空四轮**，打开电源，确认电池电压、USB 串口和应用连接正常。
2. 用低速控制检查左右两侧轮子方向一致；若一侧反转，断电后交换该侧电机的两根输出线。
3. 发 `c0,0` 确认停止；分别测试小幅前进、后退和原地转向。
4. 放到空旷平地，以最低档验证转向、刹停和上身紧固；逐步检查螺钉是否松动。

高位手机和上身会抬高重心。首次地面行驶保持低速、平地、有人手可及的急停位置；这套方案的定位是室内低速移动机器人，不沿用原 OpenBot 的高速车辆测试假设。

## 自动验证

在仓库根目录运行：

```powershell
python -m unittest discover -s body/jiaojiao_bot/tests -v
```

测试将读取仓库自带的 STEP 模型，确认适配孔与四角螺孔精确落在原 CAD 孔位，并校验每个 STL 导出项都有对应 CAD 模块。运行 CAD 导出需要本机准备 OpenSCAD；脚本只在本项目下生成 STL，不访问网络。导出目录 `cad/stl/` 已加入忽略规则，便于重复生成而不污染源代码提交。

导出后还可以运行无第三方依赖的网格尺寸检查：

```powershell
python -B body/jiaojiao_bot/tests/validate_stl.py
```

该检查会确认五个 STL 都包含完整三角面，并核对适配框的 214 × 150.352 × 5 mm 外形以及其他打印件的包围盒尺寸。

## 可调参数

接口孔位是标准 DIY 底盘的固定基准。若要适配其他打印机或手机型号，应优先改上身外观轮廓与 `phone_preview()` 的示意尺寸；变更 `corner_x`、`corner_y` 或 `phone_holes_x` 前，先在目标底盘 STEP 中复核孔位并更新接口测试。不要把装配预览里的轮胎/手机示意体当作打印件。
