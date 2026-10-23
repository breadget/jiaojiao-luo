# 数据结构与算法助教平台

实现考核第一项必做功能：读取课程 PDF、切分、真实 Embedding、FAISS 向量检索、根据原文调用大模型生成回答，并返回来源文件名和原文片段。

这是当前仓库内独立的 Django 子项目。网页由 Django 模板提供，使用原生浏览器交互，不依赖原仓库的 React 或 Node 运行环境。

## 从 Urtoris 主站进入

主站已整合课程助教与工作流对话：在仓库根目录执行 `npm run dev:course`，然后从首页的“询问 AI 智能体”进入，也可直接访问 <http://localhost:3000/ai>，直接在同一聊天框提问课程知识或描述工作流任务。旧的 `/course` 地址仍兼容。
主站采用一个聊天框、一段持久化历史和一套模型设置。知识库清单通过同源 `/api/course/status` 获取；主站 `/api/agent/chat` 在服务器端调用本项目 `/api/retrieve/` 取得 PDF 原文，再使用主站现有的模型 API 生成带来源的回答或判断工作流工具调用。PDF、向量模型和 FAISS 检索由 Django 提供，统一对话不使用 Django 的聊天密钥，也不写 Django 问答记录。原有 `/api/course/ask` 和独立 Django 问答页仍兼容。

本机 Django 默认地址为 `http://127.0.0.1:8001`。如手动改变端口，可在主站的本地环境配置 `COURSE_ASSISTANT_URL`，桥接仅接受本机 HTTP 地址。正式部署通过 Gunicorn 监听服务器本机端口，主站以 `COURSE_ASSISTANT_PUBLIC_ORIGIN` 明确允许公开的 HTTPS 站点；不开放 Django 端口。
生产配置由 `/etc/urtoris-course.env` 提供，问答记录、索引及模型缓存使用 `COURSE_ASSISTANT_STATE_DIR=/var/lib/urtoris-course`，随网站版本更新保留。

## 本地启动

需要 Python 3.10 或更新版本，建议 Python 3.12。以下命令在 `course-assistant` 目录执行：

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.lock.txt
cp .env.example .env
python manage.py migrate
python manage.py index_knowledge
python manage.py runserver 127.0.0.1:8001
```

打开 <http://127.0.0.1:8001/>。首次建立索引会下载中文向量模型；下载完成后向量检索在本机运行，无需 Embedding API 密钥。已经建好的索引和模型缓存保存在 `var/`，再次启动不需要重建。

当前开发环境的 `.venv`、数据库及索引已由开发过程初始化，可直接运行最后一条启动命令。

## 大模型配置

在本地 `.env` 文件填写你自己的 OpenAI 兼容接口信息，例如 Qwen：

```dotenv
OPENAI_API_KEY=你的密钥
OPENAI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MODEL_NAME=qwen-plus
```

修改后重启 Django。密钥仅由服务器读取，不发送到浏览器，不写入问答记录；`.env` 已被忽略，不应提交。

服务默认使用真实中文向量模型 `BAAI/bge-small-zh-v1.5`。大模型调用使用 `requests`，带有超时、输出长度限制，并将检索原文与提问作为上下文传入。

没有配置聊天密钥或模型请求失败时，仍可查看真实检索结果，页面明确显示“仅展示检索原文”。这种模式没有完成大模型生成，不能在考核时作为完整的 RAG 回答演示。

如需通过远程接口做 Embedding，在 `.env` 单独配置：

```dotenv
RAG_EMBEDDING_BACKEND=openai
RAG_EMBEDDING_MODEL=你的向量模型名称
RAG_EMBEDDING_BASE_URL=你的向量接口地址（到 v1）
RAG_EMBEDDING_API_KEY=你的向量接口密钥
```

聊天模型和向量模型分别配置；聊天模型通常不能用于 Embedding。切换向量模型后重新建立索引。

## 知识库与检索

`knowledge/` 已包含原始的 `数据结构与算法知识库文档.pdf`，共 15 页。导入时按页提取文字，再按约 650 字切分，重叠 100 字；保留文件名和原始页码。原 PDF 的文字不被改写。

```bash
# 添加或更新 PDF 后执行。来源内容、模型或切分参数改变时会重新建立索引。
python manage.py index_knowledge

# 强制重新建立
python manage.py index_knowledge --force
```

检索通过 LangChain 和 FAISS 进行语义向量相似度搜索，默认返回最多 4 段。只把达到相关性阈值的段落交给大模型，要求它依据原文回答并使用 `[1]` 等编号引用。网页提供可展开的来源原文，方便现场核对。没有足够相关内容时返回“未找到”，不补造文档内容。

索引使用原生 FAISS 文件和 JSON 保存，不加载 pickle。每次构建写入独立版本，再原子切换当前版本；构建失败保留原索引。PDF 内容和模型参数的指纹用于识别过期索引。

## 验收

1. 启动页面，确认知识库文件和页数来自实际索引。
2. 提问“队列的入队和出队时间复杂度是多少？”，展开来源，核对队列章节原文与页码。
3. 提问“顺序表和链表有什么区别？”或“KMP 算法有什么作用？”，确认检索定位相应章节。
4. 配置真实聊天密钥后，确认页面显示模型回答，内容依据检索段落，来源编号可以对应原文。
5. 提问与文档无关的问题，确认返回没有找到相关内容。
6. 添加或替换 PDF 后，运行索引命令，确认新来源被采用。

```bash
python manage.py check
python manage.py test
```

自动测试不依赖外部模型账号：使用隔离测试向量和模拟模型响应验证索引存取、引用、输入校验、CSRF 与异常行为；这些测试向量只出现在测试中。实际 PDF 和真实中文向量模型通过独立的检索验收验证。缺少真实聊天密钥时，无法验证外部模型的实际生成结果。

## 接口与目录

| 路径 | 用途 |
| --- | --- |
| `GET /` | 提问页面；也支持无 JavaScript 的表单提交 |
| `GET /api/status/` | 文件、页数、片段数、索引及聊天配置状态，不返回密钥 |
| `POST /api/retrieve/` | 接收 `{"question":"课程问题"}`，只返回规范化问题和原文来源，不调用聊天模型或写问答记录 |
| `POST /api/ask/` | 接收 `{"question":"课程问题"}`，返回回答、模式和来源 |

提交问题需要 Django CSRF token。网页自动带上 token；问题最长 2000 字，接口拒绝无效 JSON、空问题和超长请求。

来源对象包括 `id`、`filename`、`page`、`excerpt` 和 `score`。`mode` 为 `llm`（模型生成）、`retrieval_only`（仅原文）或 `no_match`（无相关资料）。

| 目录/文件 | 职责 |
| --- | --- |
| `course_assistant/` | Django 配置、路由 |
| `tutor/services/` | PDF 切分、向量模型、索引、检索、模型回答 |
| `tutor/management/commands/index_knowledge.py` | 建立与更新索引 |
| `tutor/views.py` | 页面及问答接口 |
| `tutor/models.py` | SQLite 问答记录，保存实际回答及引用 |
| `tutor/templates/`、`tutor/static/` | 页面、样式、交互 |
| `tutor/tests/` | 自动测试 |
| `knowledge/` | 输入 PDF |
| `var/` | SQLite、向量模型缓存及索引，不提交 |

当前范围仅为第一项知识库问答。调用工具和 CrewAI 学习报告属于后续考核功能。页面面向本地单人演示，默认监听本机地址。
