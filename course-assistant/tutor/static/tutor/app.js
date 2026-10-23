(() => {
  "use strict";

  const form = document.getElementById("question-form");
  const questionInput = document.getElementById("question");
  const submitButton = document.getElementById("submit-question");
  const submitLabel = submitButton.querySelector("span");
  const clearButton = document.getElementById("clear-conversation");
  const conversation = document.getElementById("conversation");
  const welcome = document.getElementById("welcome");
  const stage = document.getElementById("chat-stage");
  const errorBox = document.getElementById("form-error");
  const requestStatus = document.getElementById("request-status");
  const statusBox = document.getElementById("knowledge-status");
  const statusLabel = document.getElementById("status-label");
  const knowledgeDescription = document.getElementById("knowledge-description");
  const documentList = document.getElementById("document-list");
  const counts = document.getElementById("knowledge-counts");
  const modelStatus = document.getElementById("model-status");
  const sampleButtons = [...document.querySelectorAll(".sample-question")];
  let ready = false;
  let busy = false;
  let llmConfigured = false;

  function textElement(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = value == null ? "" : String(value);
    return element;
  }

  function icon(path, viewBox = "0 0 20 20") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
    line.setAttribute("d", path);
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "1.5");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-linejoin", "round");
    svg.append(line);
    return svg;
  }

  function updateControls() {
    submitButton.disabled = busy || !ready;
    submitLabel.textContent = busy ? "检索中" : "提问";
    form.setAttribute("aria-busy", busy ? "true" : "false");
    questionInput.readOnly = busy;
    clearButton.disabled = busy;
    sampleButtons.forEach(button => { button.disabled = busy; });
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  async function readResponse(response) {
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("服务没有返回有效结果，请稍后重试。");
    }
    if (!response.ok) {
      throw new Error(data.error?.message || "暂时无法处理问题，请稍后重试。");
    }
    return data;
  }

  async function loadStatus() {
    statusLabel.textContent = "正在检查";
    updateControls();
    try {
      const response = await fetch("/api/status/", { headers: { "Accept": "application/json" } });
      const data = await readResponse(response);
      ready = Boolean(data.ready);
      llmConfigured = Boolean(data.llm_configured);
      statusBox.dataset.state = ready ? "ready" : "missing";
      statusLabel.textContent = ready ? "可提问" : "尚未建立索引";
      knowledgeDescription.textContent = ready ? "回答会附上文档中的原文依据。" : "建立知识库索引后即可提问，方法见「运行与配置」。";
      documentList.replaceChildren();
      (Array.isArray(data.documents) ? data.documents : []).forEach(doc => {
        const item = textElement("li", "document-item");
        item.append(icon("M11 2H4v16h12V7l-5-5Zm0 0v5h5M7 11h6M7 14h4"));
        const description = document.createElement("div");
        description.append(textElement("span", "document-name", doc.name));
        if (Number.isFinite(Number(doc.pages)) && Number(doc.pages) > 0) {
          description.append(textElement("span", "document-pages", `${doc.pages} 页`));
        }
        item.append(description);
        documentList.append(item);
      });
      const details = [];
      if (Number.isFinite(Number(data.page_count)) && Number(data.page_count) > 0) details.push(`${data.page_count} 页`);
      if (Number.isFinite(Number(data.chunk_count)) && Number(data.chunk_count) > 0) details.push(`${data.chunk_count} 个知识片段`);
      counts.textContent = details.join(" · ");
      counts.hidden = !details.length;
      modelStatus.textContent = llmConfigured ? "检索文档后由大模型回答" : "仅展示检索原文 · 大模型未配置";
      if (!ready) requestStatus.textContent = "知识库尚未就绪。你可以先输入问题，建立索引后刷新页面。";
    } catch {
      statusBox.dataset.state = "error";
      statusLabel.textContent = "连接失败";
      knowledgeDescription.textContent = "请确认服务正在运行，然后刷新页面重试。";
      modelStatus.textContent = "知识库状态暂时不可用";
      requestStatus.textContent = "暂时无法连接知识库，请刷新页面重试。";
    } finally {
      updateControls();
    }
  }

  function sourcePanel(sources) {
    const panel = textElement("details", "source-panel");
    const summary = document.createElement("summary");
    summary.append(textElement("span", "", "来源依据"));
    summary.append(textElement("span", "source-count", `${sources.length} 个片段`));
    summary.append(icon("m5 8 5 5 5-5"));
    panel.append(summary);
    const list = textElement("div", "source-list");
    sources.forEach((source, index) => {
      const item = textElement("section", "source-item");
      item.setAttribute("aria-label", `来源 ${index + 1}`);
      const heading = textElement("div", "source-heading");
      const name = document.createElement("h3");
      name.append(textElement("span", "source-number", `[${index + 1}]`));
      name.append(document.createTextNode(` ${source.filename || "来源文档"}`));
      heading.append(name);
      if (source.page != null) heading.append(textElement("span", "source-page", `第 ${source.page} 页`));
      item.append(heading, textElement("blockquote", "", source.excerpt));
      list.append(item);
    });
    panel.append(list);
    return panel;
  }

  function renderAnswer(data, submittedQuestion) {
    welcome.hidden = true;
    clearButton.hidden = false;
    const exchange = textElement("article", "exchange");
    const question = textElement("div", "question-message");
    question.append(textElement("h2", "sr-only", "你的问题"), textElement("p", "", data.question || submittedQuestion));
    const answer = textElement("section", "answer-message");
    answer.setAttribute("aria-label", "助教回答");
    const heading = textElement("div", "answer-heading");
    heading.append(textElement("span", "assistant-label", "助教"));
    if (data.mode === "retrieval_only") heading.append(textElement("span", "mode-label", "仅展示检索原文"));
    answer.append(heading, textElement("div", "answer-text", data.answer));
    if (data.warning) answer.append(textElement("p", "answer-warning", data.warning));
    const sources = Array.isArray(data.sources) ? data.sources : [];
    if (sources.length) answer.append(sourcePanel(sources));
    exchange.append(question, answer);
    conversation.append(exchange);
    if (data.mode === "retrieval_only") {
      requestStatus.textContent = `已完成检索，找到 ${sources.length} 个来源片段。`;
    } else if (data.mode === "no_match") {
      requestStatus.textContent = "检索完成，未找到相关原文。";
    } else {
      requestStatus.textContent = sources.length ? `已完成回答，附 ${sources.length} 个来源片段。` : "已完成回答。";
    }
    if (window.matchMedia("(min-width: 821px)").matches) {
      stage.scrollTop = stage.scrollHeight;
    } else {
      exchange.scrollIntoView({ block: "start", behavior: "auto" });
    }
  }

  form.addEventListener("submit", async event => {
    event.preventDefault();
    const question = questionInput.value.trim();
    if (busy) return;
    if (!question) {
      showError("请先输入一个问题。");
      questionInput.focus();
      return;
    }
    if (!ready) {
      showError("知识库尚未就绪，请按「运行与配置」建立索引后刷新页面。");
      return;
    }
    busy = true;
    errorBox.hidden = true;
    requestStatus.textContent = llmConfigured ? "正在检索文档并整理回答…" : "正在检索课程原文…";
    updateControls();
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 115000);
    try {
      const csrfToken = form.querySelector("[name=csrfmiddlewaretoken]")?.value || "";
      const response = await fetch("/api/ask/", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json", "X-CSRFToken": csrfToken },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
      const data = await readResponse(response);
      renderAnswer(data, question);
      questionInput.value = "";
    } catch (error) {
      showError(error.name === "AbortError" ? "回答等待超时，你的问题已保留，请稍后重试。" : error.message === "Failed to fetch" ? "连接中断，你的问题已保留，请检查服务后重试。" : error.message);
      requestStatus.textContent = "本次提问未完成。";
    } finally {
      window.clearTimeout(timeout);
      busy = false;
      updateControls();
      questionInput.focus({ preventScroll: true });
    }
  });

  questionInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
      event.preventDefault();
      if (!busy && ready) form.requestSubmit();
    }
  });

  sampleButtons.forEach(button => {
    button.addEventListener("click", () => {
      questionInput.value = button.dataset.question;
      errorBox.hidden = true;
      questionInput.focus();
    });
  });

  clearButton.addEventListener("click", () => {
    if (busy) return;
    conversation.replaceChildren();
    welcome.hidden = false;
    clearButton.hidden = true;
    errorBox.hidden = true;
    requestStatus.textContent = "";
    questionInput.value = "";
    questionInput.focus();
  });

  document.querySelector(".sample-section").hidden = false;
  document.getElementById("composer-hint").hidden = false;
  clearButton.hidden = conversation.childElementCount === 0;
  void loadStatus();
})();
