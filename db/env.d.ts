declare namespace Cloudflare {
  interface Env {
    URTORIS_RELEASE_SHA?: string;
    DB: D1Database;
    URTORIS_API_TOKEN?: string;
    /** n8n 根地址，例如 http://127.0.0.1:5678 —— 用于把相对 webhook 路径补全。 */
    N8N_BASE_URL?: string;
    /** 网站 → n8n 的共享 Bearer 令牌（绝不下发到浏览器）。 */
    N8N_WEBHOOK_TOKEN?: string;
    /** n8n → 网站 上报执行事件时携带的令牌。 */
    URTORIS_INTERNAL_TOKEN?: string;
    /** 管理工作流编辑/发布接口的独立令牌。 */
    URTORIS_ADMIN_TOKEN?: string;
    /** 设为 0 / false / off 时关掉「本机/内网免令牌」的便捷通道。 */
    URTORIS_ADMIN_TRUST_LOCAL?: string;
    /** 允许访问执行接口的显式 Origin 列表，逗号分隔。 */
    URTORIS_ALLOWED_ORIGINS?: string;
    /** loopback-only Python Executor 地址，例如 http://127.0.0.1:3010。 */
    PYTHON_EXECUTOR_URL?: string;
    /** 网站 → Python Executor 的独立内部 Bearer 令牌。 */
    PYTHON_EXECUTOR_TOKEN?: string;
    /** 无账号 MVP 用于签发短期 Python task capability 的独立 HMAC 密钥。 */
    PYTHON_TASK_SIGNING_KEY?: string;
    /**
     * 是否把 `run_python` 授予 Agent。默认关闭；只有真实容器的九项安全门禁
     * 通过后才允许显式打开。
     */
    PYTHON_AGENT_ENABLED?: string;
    /** 仅本机站点可打开的当前用户 Shell 控制开关。 */
    LOCAL_CONTROL_ENABLED?: string;
    /** loopback-only Local Control Agent 地址，例如 http://127.0.0.1:3020。 */
    LOCAL_CONTROL_URL?: string;
    /** 网站 → Local Control Agent 的独立内部 Bearer 令牌。 */
    LOCAL_CONTROL_TOKEN?: string;
    /** 本机 Django 课程助教地址，默认 http://127.0.0.1:8001。 */
    COURSE_ASSISTANT_URL?: string;
    /** 明确开放课程检索/问答的 HTTPS 站点 Origin；默认仅本机可用。 */
    COURSE_ASSISTANT_PUBLIC_ORIGIN?: string;
    /** Loopback background workflow program executor. */
    WORKFLOW_PROGRAM_URL?: string;
    WORKFLOW_PROGRAM_TOKEN?: string;
  }
}
