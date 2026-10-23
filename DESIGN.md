---
name: Urtoris
description: 用一个身份门厅连接工作流创建与 Agent 执行。
colors:
  navy: "#123142"
  ink: "#132b39"
  paper: "#f7f6ef"
  paper-bright: "#fffef8"
  steel: "#dfe4e0"
  background: "#e8ebe7"
  line: "#b8c1bc"
  orange: "#ed5a2b"
  orange-action: "#b83b17"
  green: "#1d805e"
  yellow: "#edc94a"
typography:
  display:
    fontFamily: "var(--font-geist-sans), Arial, Helvetica, sans-serif"
    fontSize: "clamp(38px, 4.4vw, 64px)"
    fontWeight: 780
    lineHeight: 0.98
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "var(--font-geist-sans), Arial, Helvetica, sans-serif"
    fontSize: "clamp(24px, 2.2vw, 34px)"
    fontWeight: 760
    lineHeight: 1.08
    letterSpacing: "-0.035em"
  body:
    fontFamily: "var(--font-geist-sans), Arial, Helvetica, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "var(--font-geist-mono), monospace"
    fontSize: "10px"
    fontWeight: 700
    letterSpacing: "0.03em"
rounded:
  sm: "8px"
  md: "14px"
  lg: "18px"
spacing:
  sm: "10px"
  md: "18px"
  lg: "28px"
components:
  button-primary:
    backgroundColor: "{colors.orange-action}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    height: "42px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    height: "32px"
---

# Design System: Urtoris

## Overview

**Creative North Star: “日光下的调度台”**

Urtoris 把工作流当作一张会在两个工作端之间传递的任务单。首页不是并列的功能墙，而是一个清楚的身份门厅：先选择创建者或使用者，再进入专属工作台。创建端负责整理和发布，使用端负责调用、观察 Agent 并读取结果。

视觉语言延续冷灰工作面、纸白任务面和深海军蓝身份场，用安全橙标记可执行的主操作。规则线、版本戳、状态灯和等宽标签让数据状态可扫读，同时保留足够的留白让编辑任务保持安静。

**Key Characteristics:**

- 身份先于工具：入口动作只回答“我现在要做什么”。
- 状态可见：发布版本、连接状态和运行记录始终有明确位置。
- 结构化但不僵硬：连续分割面、细线和编号替代堆叠的悬浮卡片。

## Colors

调度台使用冷静的中性色承载长时间操作，深海军蓝建立身份场，安全橙只承担行动和注意力转移。

### Primary

- **深海军蓝** (#123142)：身份门厅和工作端标题的锚点。
- **安全橙** (#ed5a2b)：入口的 Agent 标记、状态强调和交互反馈。
- **操作橙** (#b83b17)：白字主按钮背景，确保正文尺寸下的可读对比度。

### Neutral

- **工作台灰** (#e8ebe7)：页面底色，给连续工作留出呼吸空间。
- **纸白** (#f7f6ef)：创建端和任务面。
- **亮纸** (#fffef8)：入口的可选择区域。
- **钢灰** (#dfe4e0)：使用端和次级区域。
- **墨色** (#132b39)：主要文字。
- **规则线** (#b8c1bc)：分隔、边框和表格线。

### Named Rules

**The Shared Version Rule.** 两个工作端只围绕同一个已发布版本协作；入口状态可以提示版本，但不创造第二份真相。

## Typography

**Display Font:** Geist Sans (with Arial/Helvetica fallback)

**Body Font:** Geist Sans (with Arial/Helvetica fallback)

**Label/Mono Font:** Geist Mono

**Character:** Sans-serif 的字面让编辑和状态读取保持直接，等宽标签只用于版本、时间、类型和接口路径等测量信息。

### Hierarchy

- **Display** (780, `clamp(38px, 4.4vw, 64px)`, 0.98): 身份门厅主标题。
- **Headline** (760, `clamp(24px, 2.2vw, 34px)`, 1.08): 工作端标题和入口标题。
- **Body** (400, 13px, 1.55): 字段说明、状态解释和运行信息，长段落保持短行宽。
- **Label** (700, 10px, tracked): 版本、操作类型、时间和接口标签。

## Layout

桌面入口使用左侧深色说明场 + 右侧上下身份入口的双栏结构，最大宽度约 1120px；它把“理解产品”和“选择行动”放在同一个首屏。进入工作端后，单端工作台保持同一最大宽度，底部运行记录在使用端出现。

在 820px 以下，入口改为上下堆叠：说明场先出现，两个入口顺序不变；工作端变为单列。520px 以下，入口标题缩小到 31px，所有关键图标按钮保持至少 44px 触控高度。页面内容默认可见，不依赖悬停才能理解。

## Elevation & Depth

系统以色调分层和 1px 规则线传达深度，默认不使用重阴影。入口外框、工作端面板和记录区域通过相邻色面与边界建立层级；交互状态依靠背景变化、焦点环和清晰文字反馈。

## Shapes

入口外框使用 18px 圆角，工作端容器使用 16px 左右的连续边界，按钮和字段使用 8px 圆角。入口两块不是漂浮卡片，而是同一张可选择的分割面；表格、任务条和步骤列表优先用规则线保持结构。

## Components

### Buttons

- **Shape:** 8px 圆角；主操作高度 42px，手机端关键操作至少 44px。
- **Primary:** 操作橙背景 (#b83b17) + 白字；用于发布和运行。
- **Hover / Focus:** 背景加深，使用全局橙色焦点环，不移动布局。
- **Secondary / Ghost:** 透明或浅灰背景，墨色文字；用于返回、刷新、添加和保存。

### Cards / Containers

- **Corner Style:** 入口 18px，工作端 16px，记录区域 14px。
- **Background:** 纸白创建面、钢灰使用面、深海军蓝说明场。
- **Shadow Strategy:** 不使用默认阴影，以色调层和规则线分层。
- **Border:** 1px 冷灰规则线。
- **Internal Padding:** 桌面使用 30–64px，手机端收紧到 22–34px。

### Inputs / Fields

- **Style:** 透明或纸白底，1px 规则线，8px 圆角；表单通过标签、编号和分隔线保持清单感。
- **Focus:** 橙色 2px 可见焦点环。
- **Error / Disabled:** 错误使用暖红提示带；禁用控件降低透明度但保留文字含义。

### Navigation

- **Style:** 顶部品牌栏始终保留 Urtoris 和服务状态。
- **Portal switch:** 工作端顶部提供“切换工作端”，返回身份门厅并把焦点移到当前页面标题。
- **Mobile:** 标题栏隐藏辅助标题，但保留品牌和连接状态点。

### Identity Gateway

入口是系统的签名组件：左侧说明为什么要选择，右侧两个全宽按钮分别展示角色、可做的事和当前版本状态。它必须先于创建或执行工具出现，并提供键盘可达的整块选择区域。

## Do's and Don'ts

### Do:

- **Do** 先展示创建端/使用端的区别，再展示细节工具。
- **Do** 用版本号、状态点和短标签表达真实的连接与发布状态。
- **Do** 在手机端为所有重复操作保留至少 44px 的触控区域。
- **Do** 让焦点、加载、错误、空状态和成功状态都能被文字理解。

### Don't:

- **Don't** 把两个工作端重新放回同一张并列编辑页面。
- **Don't** 用低对比度橙色承载白色正文按钮文字。
- **Don't** 用阴影、渐变或装饰条替代版本和状态信息。
- **Don't** 把演示数据或接口密钥写入公开页面或仓库。
