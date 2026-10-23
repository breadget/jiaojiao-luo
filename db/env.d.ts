declare namespace Cloudflare {
  interface Env {
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
  }
}
