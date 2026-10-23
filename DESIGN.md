---
name: Urtoris
description: 用身份门厅连接创建、对话与机器人操作的多工作台系统。
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
  studio-background: "#08111a"
  studio-panel: "#0d1822"
  studio-line: "#263746"
  studio-text: "#edf4f8"
  studio-action: "#ff6b35"
  consumer-background: "#111214"
  consumer-sidebar: "#1a1b1e"
  consumer-raised: "#26272b"
  consumer-raised-hover: "#303136"
  consumer-line: "#303136"
  consumer-text: "#f1f2f4"
  consumer-muted: "#a3a6ad"
  consumer-faint: "#757981"
  consumer-action: "#7891c7"
  consumer-action-hover: "#8ca6df"
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
  consumer-body:
    fontFamily: "var(--font-geist-sans), Arial, Helvetica, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.72
  consumer-prompt:
    fontFamily: "var(--font-geist-sans), Arial, Helvetica, sans-serif"
    fontSize: "clamp(24px, 3vw, 34px)"
    fontWeight: 590
    letterSpacing: "-0.03em"
rounded:
  sm: "8px"
  md: "14px"
  lg: "18px"
  consumer-control: "9px"
  consumer-nav: "11px"
  consumer-surface: "16px"
  full: "999px"
spacing:
  sm: "10px"
  md: "18px"
  lg: "28px"
  consumer-inset: "12px"
  consumer-gutter: "24px"
  consumer-stream-gap: "30px"
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
  consumer-sidebar:
    backgroundColor: "{colors.consumer-sidebar}"
    textColor: "{colors.consumer-text}"
    width: "280px"
  consumer-shortcut-primary:
    backgroundColor: "#3a3b40"
    textColor: "{colors.consumer-text}"
    rounded: "{rounded.consumer-nav}"
    height: "44px"
  consumer-composer:
    backgroundColor: "#292a2e"
    textColor: "{colors.consumer-text}"
    rounded: "{rounded.consumer-surface}"
    padding: "{spacing.consumer-inset}"
  consumer-send:
    backgroundColor: "{colors.consumer-action}"
    textColor: "#101218"
    rounded: "{rounded.full}"
    size: "38px"
---

# Design System: Urtoris

## Overview

**Creative North Star: “一座门厅，四张工作台”**

Urtoris 以身份门厅连接四个各自成立的操作世界，而不是强迫所有任务穿同一套皮肤。门厅负责让人选择意图；创建端把工作流画成可运行的图；使用端是一张安静的 AI 对话工作台；机器人端把视频、方向控制和连接事实组织成直接的遥控面。产品关系一致，视觉材料按工作性质分工。

本次使用端的方向是炭黑画布、石墨侧栏、低对比度分层和柔和蓝色行动点。它优先展示真实聊天记录、AI 自动生成的短标题、当前对话和输入；标题生成、持久化、工作流状态与执行证据在后台完成，只有用户需要时才展开。它不沿用旧的纸白值班簿构图，也不把状态、说明和日志同时推入首屏。

各面保持自己的既有视觉世界：

- **身份门厅：日光下的调度台。** 冷灰工作面、纸白入口、深海军蓝说明场和安全橙选择点；先回答“我要进入哪里”。
- **创建端：夜间机器人调度台。** 黑蓝画布、精密端口色、深色面板与亮橙命令；节点库、画布、 Inspector 和运行面板共同解释一张可执行图。
- **使用端：安静的深色对话工作台。** 左侧是真实会话，右侧是当前对话；用户直接提出要求，Agent 直接回复，执行细节默认收起。
- **机器人端：轻色遥控工作面。** 纸白控制卡围绕深色视频窗，绿色说明连通、橙色说明动作或风险，不继承使用端的炭黑画布。

**Key Characteristics:**

- 每个工作端有清楚的视觉所有权，跨端共享的是产品关系、字体和可访问性标准，不是强制共用背景色。
- 使用端默认只保留导航、对话、输入与必要设置；证据可找得到，但不抢占主画面。
- 状态必须来自真实数据，并用文字、图标或位置共同表达；颜色从不单独承担含义。

## Colors

Urtoris 使用表面限定的颜色系统：门厅与机器人端是冷灰纸面，创建端是黑蓝工程台，使用端是炭黑对话台。任何颜色规则先判断它属于哪张工作台。

### Primary

- **深海军蓝** (`navy`, #123142)：身份门厅的说明场、轻色世界中的品牌锚点和深色视频容器。
- **安全橙 / 操作橙** (`orange`, #ed5a2b；`orange-action`, #b83b17)：门厅选择、创建端以外的高意图操作、错误与风险事实；白字按钮使用更深的操作橙。
- **对话柔蓝** (`consumer-action`, #7891c7；悬停 #8ca6df)：仅属于使用端的发送按钮和明确选中动作。它是稀少的行动点，不是装饰色。
- **创建端亮橙** (`studio-action`, #ff6b35)：夜间创建端的运行、发布、选中和焦点；不借给使用端充当主色。

### Secondary

- **运行绿** (`green`, #1d805e)：轻色世界的连接与成功事实。
- **提醒黄** (`yellow`, #edc94a)：加载、协商与需要注意但未失败的状态。

### Neutral

- **门厅纸面组** (`background`, #e8ebe7；`paper`, #f7f6ef；`paper-bright`, #fffef8；`steel`, #dfe4e0)：入口、创建表单和机器人控制卡的工作面。
- **门厅墨线组** (`ink`, #132b39；`line`, #b8c1bc)：轻色世界的正文、分隔和表格线。
- **创建端夜色组** (`studio-background`, #08111a；`studio-panel`, #0d1822；`studio-line`, #263746；`studio-text`, #edf4f8)：图形编排环境的画布、面板、结构线和文字。
- **使用端炭黑组** (`consumer-background`, #111214；`consumer-sidebar`, #1a1b1e；`consumer-raised`, #26272b；`consumer-line`, #303136)：对话画布、侧栏、悬浮层和 1px 冷灰边界。
- **使用端文字组** (`consumer-text`, #f1f2f4；`consumer-muted`, #a3a6ad；`consumer-faint`, #757981)：正文、辅助信息和时间戳，按信息必要性逐级后退。

### Named Rules

**The Surface Ownership Rule.** 使用端的炭黑与柔蓝只作用于 `.consumer-workspace`；身份门厅、创建端和机器人端继续使用各自已经实现的色组。

**The Quiet Action Rule.** 使用端的蓝色只标记可执行或已选中的关键点；同一首屏不能把标题、状态、消息和按钮都染成蓝色。

**The Shared Truth Rule.** 四个工作端可以呈现不同材料，但已发布版本、连接状态、执行结果和权限事实只能有一份真实来源。

## Typography

**Display Font:** Geist Sans（Arial / Helvetica fallback）

**Body Font:** Geist Sans（Arial / Helvetica fallback）

**Label/Mono Font:** Geist Mono

**Character:** 门厅用紧凑而有方向感的大标题建立选择；创建端和机器人端用等宽小字承载端口、版本与遥测；使用端把字体退到内容之后，以自然句子、短标题和低调时间戳支持长时间对话。

### Hierarchy

- **Display** (780, `clamp(38px, 4.4vw, 64px)`, 0.98)：只用于身份门厅主标题。
- **Headline** (760, `clamp(24px, 2.2vw, 34px)`, 1.08)：轻色工作端标题和创建端主要区块标题。
- **Consumer Prompt** (590, `clamp(24px, 3vw, 34px)`)：空对话唯一的问题“想从哪里开始？”，不附带说明段落。
- **Consumer Title / Navigation** (530–620, 12–14px)：当前会话标题、左栏聊天记录和主要导航；AI 自动标题必须单行截断，不能撑宽侧栏。
- **Body** (400, 13px, 1.55)：门厅、表单、机器人状态与说明。
- **Consumer Body** (400, 14px, 1.72)：Agent 回复和用户要求，优先保障连续阅读。
- **Label** (700, 10px, tracked)：版本、时间、运行号、端口和接口路径；不用于普通对话正文。

### Named Rules

**The Automatic Title Rule.** 首轮对话完成后由 AI 生成短标题；左栏和页眉显示同一标题，失败时保留“新对话”，标题生成不得打断回复。

## Layout

身份门厅在桌面使用最大约 1120px 的左右双栏：深色说明场在左，三个身份入口在右；820px 以下改为上下堆叠，520px 以下收紧标题和内边距。门厅负责分流，不在入口预览完整工作台。

创建端维持全视口夜间工程布局：顶部命令栏，下方 224px 节点库、弹性画布和 326px Inspector，底部运行面板；900px 以下 Inspector 变成侧抽屉，节点库缩成 108px。机器人端在 1080px 以上使用视频主区加控制侧栏，以下改为单列。

使用端占满整个动态视口。桌面首屏使用固定宽度 280px 的会话侧栏和占满剩余空间的当前对话；侧栏收起后为 72px。主区顶部是 64px 会话标题栏，中部对话流最大宽度 840px，底部输入容器最大宽度 860px 并水平居中。空会话只显示一个短问题和宽输入框；发送按钮固定在输入容器右下角，加号在左下角。

执行面板默认收起，把宽度留给对话；用户显式展开后才占用 320–380px。设置使用原生模态置于 top layer。820px 以下侧栏移到顶部并限制高度，执行面板作为主区覆盖层；520px 以下加号菜单变为单列，消息和输入继续占满可用宽度。所有布局默认可理解，不依赖悬停暴露信息。

### Named Rules

**The Conversation-First Rule.** 使用端的默认宽度属于当前对话；步骤、运行日志和台账只有在用户展开执行详情后出现。

**The First-Viewport Test.** 新会话首屏只能看见会话导航、一个短问题和一个可直接输入的宽输入框，不得出现工作流说明卡、状态总览或常驻日志。

## Elevation & Depth

系统总体以相邻色面和 1px 边界表达深度。门厅与机器人端以冷灰边界分层；创建端允许节点、控件和抽屉使用克制的工程阴影；使用端主要依靠炭黑、石墨和抬升灰之间的小幅明度差，只有输入容器、错误提示和原生设置模态使用柔和阴影。消息列表本身保持平面。

### Named Rules

**The Evidence-On-Demand Rule.** 阴影只能说明真实层级，例如输入器、菜单、模态或抽屉；不能用一组浮卡把本应连续的对话拆成仪表盘。

## Shapes

身份门厅外框使用 18px 圆角，轻色工作卡和创建端节点多使用 12–16px 圆角，按钮与字段以 8–10px 为主。机器人视频窗和控制卡保持 12–16px 的稳固轮廓。

使用端侧栏导航项使用 9–11px 圆角，输入容器使用 16px 圆角，发送按钮为 38px 圆形。用户消息使用 16px 圆角并在右下收成 4px，保留“这是我说的”这一方向性；Agent 回复不画气泡和外框，只以头像与排版建立归属。所有深色分层都用 1px 冷灰边界，不用厚描边。

## Components

### Buttons

- **轻色主操作：** 8px 圆角、42px 高，深操作橙配白字；用于发布等不可忽略的动作。
- **创建端命令：** 9px 圆角、34–44px 高，暗面上用亮橙、绿色或中性描边说明运行语义。
- **使用端主捷径：** “新对话”高 44px，石墨填充和细边界；它是侧栏唯一常驻的强导航动作。
- **使用端发送：** 38px 圆形柔蓝按钮，位于输入框右下角；禁用时回到中性灰，不用透明度制造不可读状态。
- **机器人控制：** 方向键高 58px，按下用操作橙边界和内描边显示当前动作。
- **Hover / Focus：** 使用同一色组内的小幅明度变化；键盘焦点始终有可见 2px 环，不以位移制造反馈。

### Cards / Containers

- **门厅与机器人端：** 纸白或亮纸背景、1px 冷灰边界、14–18px 圆角。
- **创建端：** 黑蓝面板与节点卡依靠端口色、边界和少量结构阴影区分层级。
- **使用端：** 主画布和会话侧栏是连续色面，不是卡片集合；输入容器是主要抬升面，石墨背景、16px 圆角和 12px 内边距。
- **Shadow Strategy：** 默认平面；只有真实浮层、抽屉和可拖拽节点允许阴影。

### Inputs / Fields

- **轻色字段：** 透明或纸白底、1px 规则线、8px 圆角；创建表单可用下划线式字段保持清单感。
- **创建端字段：** 黑蓝底、8px 圆角、冷灰边界，焦点转为更亮的同色边界。
- **使用端输入：** 14px 文字、透明底、无内框，置于石墨输入容器中；最小高度 64px，可增长到 180px。
- **Error / Disabled：** 错误必须以文字和暖红边界共同表达；禁用控件仍保留可读标签与原因。

### Navigation

- **身份门厅：** 整块入口都可点击，角色、能力和可用状态在一个连续区域内完成说明。
- **使用端侧栏：** 顶部品牌与收起按钮，中部“新对话 / 工作流”，其下是真实聊天记录；每行显示 AI 标题与更新时间，当前项使用抬升石墨底，不使用橙色页签。
- **Collapsed State：** 桌面收起为 72px，只保留图标；移动端仍显示完整品牌与主要导航，避免失去上下文。

### Conversation Stream

Agent 回复是无框的连续文字，左侧保留 30px 头像；用户消息靠右，用石墨气泡收束。对话间距为 30px。附件、产物、Python 或 Shell 证据跟随对应回复出现；失败也留在原位置并明确标记，不用全局空状态替代。

### Composer

宽输入容器固定在主区底部并水平居中。第一行是多行输入；第二行左侧为附件 / 工作流 / 模式菜单，右侧为圆形发送按钮。菜单使用 `fieldset` + `legend` 分组，当前选择用 `aria-pressed`，Esc 或外部点击关闭并把焦点还给加号。

### Settings and Execution Evidence

设置使用原生 `<dialog>` + `showModal()`，承载模型、API、本机权限和保存位置；Esc、遮罩、焦点锁与关闭后归位交给浏览器。执行详情由页眉按钮显式展开，包含路线、日志、结果和台账；默认收起，不与对话争夺首屏。

### Identity Gateway, Studio, and Robot

身份门厅继续以深海军蓝说明场和纸面入口作为签名组件。创建端继续保留节点库、React Flow 画布、Inspector、底部运行面板与端口色。机器人端继续以深色视频窗、方向控制和状态卡组织操作。使用端的暗色组件不得反向覆盖这三面。

## Do's and Don'ts

### Do:

- **Do** 在使用端先展示真实聊天记录、AI 自动标题、当前对话和输入，让人进入后立刻可以提出要求。
- **Do** 让 280px 侧栏、840px 对话流和 860px 输入容器形成稳定的桌面阅读轴。
- **Do** 默认收起执行详情，并让运行、日志、产物与权限事实在需要时可追溯。
- **Do** 用炭黑、石墨、冷灰边界和稀少柔蓝建立低对比度层级。
- **Do** 保留身份门厅、创建端和机器人端各自现有的材料、颜色与布局逻辑。
- **Do** 让焦点、加载、失败、空状态、禁用和成功都能由文字理解；手机端关键操作至少 44px。
- **Do** 如实区分模拟、真实模型、n8n、Python 和本机 Shell，不用动画伪造执行证据。

### Don't:

- **Don't** 把使用端恢复成默认同时展示工作流说明、步骤状态、运行日志和结果的工作流仪表盘。
- **Don't** 在空对话首屏堆欢迎段落、教程卡、建议提示词或多重主按钮；一个短问题和输入框就够。
- **Don't** 给 Agent 回复套常驻卡片或高对比气泡；它应像正文一样安静，用户消息才使用石墨气泡。
- **Don't** 把柔蓝扩散到标题、时间戳和普通正文，或把门厅 / 创建端 / 机器人端整体改成使用端暗色世界。
- **Don't** 用阴影、渐变或装饰条替代真实版本、连接、权限与运行状态。
- **Don't** 把演示数据、API Key 或接口密钥写入公开页面或仓库。
