---
name: 数据结构与算法助教
description: 延续安静的深色对话工作台，以可展开的课程原文支撑知识问答。
colors:
  canvas: "#111214"
  sidebar: "#1a1b1e"
  raised: "#26272b"
  raised-hover: "#303136"
  line: "#303136"
  text: "#f1f2f4"
  muted: "#a3a6ad"
  action: "#7891c7"
  action-hover: "#8ca6df"
  error: "#e7a7a7"
  composer: "#292a2e"
  excerpt: "#1c1d20"
  excerpt-text: "#d4d6dc"
  control-ink: "#101218"
typography:
  prompt:
    fontFamily: '"Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "clamp(24px, 2.8vw, 34px)"
    fontWeight: 590
    lineHeight: 1.35
    letterSpacing: "-0.03em"
  body:
    fontFamily: '"Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.72
  answer:
    fontFamily: '"Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.85
  label:
    fontFamily: '"Geist Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.72
  code:
    fontFamily: '"Geist Mono", ui-monospace, SFMono-Regular, Consolas, monospace'
    fontSize: "10px"
rounded:
  control: "9px"
  surface: "16px"
  ghost: "8px"
  bubble-corner: "4px"
spacing:
  inset: "12px"
  gutter: "24px"
  stream-gap: "38px"
components:
  sidebar:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.text}"
    width: "280px"
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.control-ink}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "7px 12px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
    textColor: "{colors.control-ink}"
    rounded: "{rounded.control}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.ghost}"
    height: "38px"
    padding: "6px 10px"
  composer:
    backgroundColor: "{colors.composer}"
    textColor: "{colors.text}"
    rounded: "{rounded.surface}"
    padding: "15px 15px 11px"
  source-excerpt:
    backgroundColor: "{colors.excerpt}"
    textColor: "{colors.excerpt-text}"
    rounded: "{rounded.control}"
    padding: "13px 16px"
---

# Design System: 数据结构与算法助教

## Overview

**Creative North Star: "安静的深色对话工作台"**

本子项目继承父项目 [DESIGN.md](../DESIGN.md) 中使用端的视觉权威：炭黑画布、石墨侧栏、低对比度分层和稀少柔蓝。这里只记录独立 Django 问答页已经实现的表达，不改变父项目其他工作端。

学生先提出问题，再读回答，最后按需展开原文依据。课程文档与知识库就绪状态留在侧栏；对话主区保持连续阅读，不以装饰图像或状态卡分散注意。具体表面方向另见 [docs/ui-surface.md](docs/ui-surface.md)。

**Key Characteristics:**

- 左栏交代知识库事实，主区围绕提问、回答和输入展开。
- 用户问题使用石墨气泡，助教回答保持无框正文。
- 原文依据按回复折叠，文件、页码和摘录可一起核对。
- 加载、失败、模型模式与无匹配结果都用文字说明。

## Colors

### Primary

柔蓝行动色只用于提问按钮、焦点和明确的交互反馈；悬停略微提亮。错误使用暖红文字，知识库状态点另配文字，颜色不单独承担含义。

### Neutral

炭黑画布与石墨侧栏形成稳定的工作面。抬升灰用于用户问题与悬停项，冷灰细线分隔页眉、输入框与证据。正文是近白色，辅助说明退到灰色；原文摘录使用更暗的内嵌底面和稍柔和的文字。

**The Quiet Action Rule.** 蓝色只标记行动与焦点，普通标题、回答和来源信息保持中性。

## Typography

字体声明沿用 Geist Sans，并依次回退到系统及中文字体；配置代码声明 Geist Mono 并提供等宽回退。当前页面没有加载外部字体文件。

空状态只有一个短问题，手机最窄布局固定为 25px。课程标题为 15px / 600，主区标题与知识状态为 13px；正文使用 `body`，回答使用更宽松的 `answer` 行高。辅助标签、来源标题和按钮为 12px，模式、页码、计数为 11px。回答最长约 75ch，原文和长文件名允许折行；页码与计数使用等宽数字。

## Layout

桌面采用全动态视口双栏：侧栏固定 280px、高度 100dvh 并可独立滚动；主区顶部为 64px 页眉，中部对话滚动，输入区域固定在主区布局底部。对话轴最大 840px，输入区域最大 908px，扣除左右内边距后的输入框最大 860px。相邻问答之间留 38px；回答与用户问题保持清楚的左右归属。

820px 及以下改为整页自然滚动，侧栏移到顶部，以双栏排列知识库和示例问题；主区页眉缩为 54px，输入框随内容流动。520px 及以下，侧栏主体改为单列，示例问题仍是两列；文档名与页数紧凑排列，来源页码换到下一行。页面最小宽度为 320px。手机提问、清空和示例操作至少 44px 高；521–820px 的示例行实际为 36px，不扩写成已满足所有触控尺寸。

**The Evidence-On-Demand Rule.** 证据跟随对应回答，默认折叠；展开不得建立并列的常驻日志面板。

## Elevation & Depth

当前页面没有阴影。画布、侧栏、输入器、用户气泡与原文摘录依靠相邻色面和 1px 边界区分层级。来源折叠箭头只用 150ms ease-out 旋转；减少动态效果偏好会关闭过渡与动画。

## Shapes

输入框使用柔和的 `surface` 圆角；用户气泡沿用同一轮廓并在右下收成 `bubble-corner`。提问按钮、示例项与原文摘录使用 `control` 圆角，清空按钮使用 `ghost`。助教正文没有气泡、卡片或厚描边。

## Components

### Buttons and Navigation

“提问”是唯一的柔蓝主按钮；“清空本页”是中性文字按钮，仅在增强后的页面已有问答时出现。示例问题置于侧栏，点击仅填入问题并聚焦输入，不自动提交。控件悬停只改变同一色组的明度。按钮、链接和折叠标题的键盘焦点显示 2px 柔蓝轮廓，偏移 4px。

### Composer and States

多行输入有隐藏的完整标签、2000 字符上限，最小高度 66px，可手动调整到 180px。Enter 换行，Ctrl / ⌘ + Enter 提问；中文输入法组合状态不会误提交。输入器以边界变亮表示焦点。

检查知识库期间及未就绪时禁用增强页面的提问；请求期间显示“检索中”，设置 `aria-busy`，输入只读，并禁用清空与示例。空问题、服务错误与超时使用 `role="alert"`；请求进展和完成结果使用 polite 状态播报。失败保留问题，完成后清空输入并归还焦点。顶部跳转链接可直接聚焦提问区域。

页面使用渐进增强：没有 JavaScript 时仍通过原生表单提交并显示服务端结果，失败输入保留；仅依赖 JavaScript 的示例、快捷键提示和清空控件在增强前隐藏。

### Answers and Source Evidence

助教回答保留换行，以“助教”小标签建立归属。`llm` 表示检索后由模型组织回答；`retrieval_only` 明确显示“仅展示检索原文”，完成状态为“已完成检索”；`no_match` 明确说明未找到相关原文。模型未配置与模型请求失败必须如实呈现，不用重复提示堆叠同一事实。

有来源时使用原生 `details` / `summary`，默认显示“来源依据”和片段数，展开后依序显示编号、PDF 文件名、第几页和原文摘录。键盘可操作折叠，长文可折行。未找到依据时不创建空来源容器。对话仅属于本页，不暗示跨页持久记录或多轮记忆。

## Do's and Don'ts

### Do:

- **Do** 继承父项目使用端的炭黑、石墨、柔蓝与连续正文关系。
- **Do** 让知识库、回答模式和来源信息反映服务实际返回的数据。
- **Do** 让文件名、页码和原文摘录跟随同一条回答，保持可核对。
- **Do** 保留键盘焦点、错误播报、失败输入与无 JavaScript 的原生提交。

### Don't:

- **Don't** 给助教回答增加常驻卡片、装饰图像或高对比气泡。
- **Don't** 把检索原文称作已完成的大模型回答，或为无匹配结果伪造来源。
- **Don't** 把本页清空操作描述成删除持久会话。
- **Don't** 用本子项目的局部规则覆盖父项目门厅、创建端或机器人端。
