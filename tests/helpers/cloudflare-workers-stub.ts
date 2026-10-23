/**
 * `cloudflare:workers` 的测试替身（由 loader-hooks.mjs 重定向过来）。
 *
 * 真实实现从 workerd 的绑定里读环境变量；测试里我们只关心
 * `URTORIS_ADMIN_TOKEN` / `URTORIS_API_TOKEN` 这类开关，所以用一个
 * 可写对象代替，测试用例直接改它。
 */
const globalScope = globalThis as typeof globalThis & {
  __urtorisTestEnv?: Record<string, string | undefined>;
};

export const env: Record<string, string | undefined> = (globalScope.__urtorisTestEnv ??= {});

export function resetEnv(values: Record<string, string | undefined> = {}) {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, values);
}

const workerModule = { env };
export default workerModule;
