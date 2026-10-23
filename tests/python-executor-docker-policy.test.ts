import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  DockerSandboxBackend,
  SandboxInfrastructureError,
  buildDockerCreateArgs,
} from '@/services/python-executor/docker-runner';

describe('Python Docker sandbox policy', () => {
  it('把每个隔离产物校验器都收进运行镜像', async () => {
    const root = new URL('../services/python-executor/', import.meta.url);
    const [dockerfile, dockerignore] = await Promise.all([
      readFile(new URL('Dockerfile', root), 'utf8'),
      readFile(new URL('.dockerignore', root), 'utf8'),
    ]);
    for (const name of [
      'validate_png.py',
      'validate_xlsx.py',
      'validate_pdf.py',
      'validate_ooxml.py',
    ]) {
      assert.match(dockerfile, new RegExp(`image/${name}`));
      assert.match(dockerignore, new RegExp(`!image/${name}`));
    }
  });

  it('constructs Docker arguments without a shell or dangerous mounts', () => {
    const arguments_ = buildDockerCreateArgs({
      image: 'urtoris/python-executor:test',
      containerName: 'urtoris-run_test',
      sourcePath: '/var/lib/urtoris-python/runs/run/source/main.py',
      inputDir: '/var/lib/urtoris-python/runs/run/input',
      outputDir: '/var/lib/urtoris-python/runs/run/output',
      memoryBytes: 512 * 1024 * 1024,
      cpuCount: 1,
      processes: 64,
    });
    const joined = arguments_.join(' ');
    assert.equal(arguments_[0], 'create');
    assert.match(joined, /--network none/);
    assert.match(joined, /--read-only/);
    assert.match(joined, /--user 65532:65532/);
    assert.match(joined, /--cap-drop ALL/);
    assert.match(joined, /no-new-privileges=true/);
    assert.match(joined, /--pids-limit 64/);
    assert.match(joined, /--memory 536870912/);
    assert.match(joined, /--memory-swap 536870912/);
    assert.match(joined, /--log-driver local/);
    assert.match(joined, /--log-opt max-size=3m/);
    // 结果目录必须是可写挂载而不是容器内 tmpfs：tmpfs 随容器停止消失，
    // 停机后再复制只会拿到空目录。
    assert.match(
      joined,
      /type=bind,src=\/var\/lib\/urtoris-python\/runs\/run\/output,dst=\/workspace\/output,bind-propagation=rprivate/,
    );
    assert.doesNotMatch(joined, /--tmpfs \/workspace\/output/);
    assert.match(joined, /\/tmp:rw,noexec,nosuid,nodev,size=67108864/);
    assert.doesNotMatch(joined, /docker\.sock|--privileged|--network host/);
    assert.equal(arguments_.includes('sh'), false);
    assert.equal(arguments_.includes('-c'), false);
  });

  it('requires an image digest in production', () => {
    assert.throws(
      () =>
        new DockerSandboxBackend({
          image: 'urtoris/python-executor:latest',
          production: true,
        }),
      SandboxInfrastructureError,
    );
    assert.doesNotThrow(
      () =>
        new DockerSandboxBackend({
          image: `urtoris/python-executor@sha256:${'a'.repeat(64)}`,
          production: true,
        }),
    );
    // 本机构建的镜像用内容 ID 固定，同样属于不可变引用。
    assert.doesNotThrow(
      () =>
        new DockerSandboxBackend({
          image: `sha256:${'b'.repeat(64)}`,
          production: true,
        }),
    );
    assert.throws(
      () =>
        new DockerSandboxBackend({
          image: 'urtoris/python-executor:dev',
          production: true,
        }),
      SandboxInfrastructureError,
    );
  });

  it('passes the long profile CPU and memory limits to Docker', () => {
    const arguments_ = buildDockerCreateArgs({
      image: 'urtoris/python-executor:test',
      containerName: 'urtoris-run_long',
      sourcePath: '/var/lib/urtoris-python/runs/long/source/main.py',
      inputDir: '/var/lib/urtoris-python/runs/long/input',
      outputDir: '/var/lib/urtoris-python/runs/long/output',
      memoryBytes: 2 * 1024 * 1024 * 1024,
      cpuCount: 2,
      processes: 64,
    });
    const joined = arguments_.join(' ');
    assert.match(joined, /--memory 2147483648/);
    assert.match(joined, /--memory-swap 2147483648/);
    assert.match(joined, /--cpus 2/);
  });
});
