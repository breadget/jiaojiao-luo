import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  PythonTaskCapabilityError,
  createPythonTaskCapability,
  verifyPythonTaskCapability,
} from '@/lib/server/python-task-capability';
import { resetEnv } from './helpers/cloudflare-workers-stub';

afterEach(() => resetEnv());

describe('Python task capability', () => {
  it('binds a seven-day token to one opaque task ID', async () => {
    resetEnv({ PYTHON_TASK_SIGNING_KEY: 'c'.repeat(64) });
    const now = 1_800_000_000_000;
    const capability = await createPythonTaskCapability(now);
    assert.match(capability.taskId, /^task_[a-f0-9]{32}$/);
    assert.equal(
      await verifyPythonTaskCapability({
        taskId: capability.taskId,
        taskToken: capability.taskToken,
        now,
      }),
      true,
    );
    assert.equal(
      await verifyPythonTaskCapability({
        taskId: `task_${'0'.repeat(32)}`,
        taskToken: capability.taskToken,
        now,
      }),
      false,
    );
  });

  it('rejects expired and modified task tokens', async () => {
    resetEnv({ PYTHON_TASK_SIGNING_KEY: 'd'.repeat(64) });
    const now = 1_800_000_000_000;
    const capability = await createPythonTaskCapability(now);
    assert.equal(
      await verifyPythonTaskCapability({
        taskId: capability.taskId,
        taskToken: capability.taskToken,
        now: now + 7 * 24 * 60 * 60 * 1000,
      }),
      false,
    );
    const final = capability.taskToken.at(-1) === 'a' ? 'b' : 'a';
    assert.equal(
      await verifyPythonTaskCapability({
        taskId: capability.taskId,
        taskToken: `${capability.taskToken.slice(0, -1)}${final}`,
        now,
      }),
      false,
    );
  });

  it('fails closed when the signing key is missing', async () => {
    resetEnv();
    await assert.rejects(
      () => createPythonTaskCapability(),
      PythonTaskCapabilityError,
    );
  });
});
