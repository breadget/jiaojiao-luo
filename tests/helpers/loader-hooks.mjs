/**
 * 测试期的模块解析钩子。
 *
 * `cloudflare:workers` 是 workerd 专有的 scheme，Node 的 ESM loader 解析不了它
 * （会在 resolve 阶段就抛 ERR_UNSUPPORTED_ESM_URL_SCHEME）。测试不是跑在 workerd
 * 里的，所以这里把它重定向到一个本地 stub，让 `env` 可以按用例改写。
 *
 * 用法（见 package.json 的 test 脚本）：
 *   node --experimental-test-module-mocks --import tsx \
 *        --import ./tests/helpers/loader-hooks.mjs --test tests/*.test.ts
 */
import { registerHooks } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workerStub = pathToFileURL(join(here, 'cloudflare-workers-stub.ts')).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') {
      return { url: workerStub, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
