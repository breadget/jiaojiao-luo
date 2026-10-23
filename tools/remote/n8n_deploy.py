#!/usr/bin/env python3
"""
在 ECS 上部署 Urtoris 的 n8n 工作流体系（标准库实现，不依赖 pip）。

做四件事：
  1. 备份 n8n 的 SQLite 库（动数据库之前必须先备份）
  2. 把运维参数写进 /opt/n8n/.env 并重启 n8n
  3. 通过 REST 建立 Webhook 鉴权凭证（Header Auth）
  4. 按依赖顺序导入并发布工作流，最后核对 webhook 注册表

用法（在服务器上）：
  python3 n8n_deploy.py --bundle /tmp/urtoris-bundle --phase all
"""

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

N8N_HOME = Path('/root/.n8n')
N8N_ENV = Path('/opt/n8n/.env')
N8N_DB = N8N_HOME / 'database.sqlite'
BASE = 'http://127.0.0.1:5678'
OWNER_PASS_FILE = Path('/opt/n8n/.owner_pass')
OWNER_EMAIL = 'admin@urtoris.local'

opener = urllib.request.build_opener()

# n8n 的会话 cookie 带 Secure 标记，而我们是走 http://127.0.0.1 访问的 ——
# Python 的 cookiejar 会因此拒绝回传它（curl 不会）。所以这里手工抓住 Set-Cookie
# 并在后续请求里显式回填，绕开 cookiejar 的这条策略。
SESSION_COOKIE = None


def log(message):
    print(f'  {message}', flush=True)


def rest(method, path, payload=None, timeout=60):
    url = BASE + path
    data = None
    headers = {'User-Agent': 'Mozilla/5.0 (urtoris-deploy)', 'Accept': 'application/json'}
    if SESSION_COOKIE:
        headers['Cookie'] = SESSION_COOKIE
    if payload is not None:
        data = json.dumps(payload).encode()
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read().decode()
            return response.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as error:
        body = error.read().decode()
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = body[:500]
        return error.code, parsed


def wait_ready(seconds=180):
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            status, _ = rest('GET', '/rest/settings', timeout=5)
            if status == 200:
                return True
        except Exception:
            pass
        time.sleep(2)
    return False


def backup_database():
    stamp = time.strftime('%Y%m%d-%H%M%S')
    target = N8N_HOME / f'backup-{stamp}-predeploy.sqlite'
    source = sqlite3.connect(str(N8N_DB))
    destination = sqlite3.connect(str(target))
    with destination:
        source.backup(destination)
    source.close()
    destination.close()
    log(f'数据库已备份 → {target} ({target.stat().st_size // 1024} KB)')
    backups = sorted(N8N_HOME.glob('backup-*-predeploy.sqlite'))
    for old in backups[:-5]:
        old.unlink()
        log(f'清理旧备份 {old.name}')
    return str(target)


def patch_env(env_pairs):
    lines = []
    if N8N_ENV.exists():
        lines = N8N_ENV.read_text().splitlines()
    index = {}
    for position, line in enumerate(lines):
        if '=' in line and not line.strip().startswith('#'):
            index[line.split('=', 1)[0].strip()] = position
    changed = []
    for key, value in env_pairs.items():
        rendered = f'{key}={value}'
        if key in index:
            if lines[index[key]] != rendered:
                lines[index[key]] = rendered
                changed.append(key)
        else:
            lines.append(rendered)
            changed.append(key)
    N8N_ENV.write_text('\n'.join(lines) + '\n')
    os.chmod(N8N_ENV, 0o600)
    log(f'.env 已更新：{", ".join(changed) if changed else "无变化"}')
    return changed


def drop_env(keys):
    """移除不再使用的明文令牌（改用加密凭证存储后不该继续留在 .env 里）。"""
    if not N8N_ENV.exists():
        return []
    wanted = set(keys)
    lines = N8N_ENV.read_text().splitlines()
    kept = [line for line in lines if line.split('=', 1)[0].strip() not in wanted]
    removed = [line.split('=', 1)[0].strip() for line in lines if line.split('=', 1)[0].strip() in wanted]
    if removed:
        N8N_ENV.write_text('\n'.join(kept) + '\n')
        os.chmod(N8N_ENV, 0o600)
        log(f'.env 已清除明文令牌：{", ".join(removed)}')
    return removed


def restart_n8n():
    log('重启 n8n …')
    subprocess.run(['systemctl', 'restart', 'n8n'], check=True)
    if not wait_ready():
        raise SystemExit('n8n 重启后未在 180 秒内就绪')
    log('n8n 已就绪')


def login():
    global SESSION_COOKIE
    password = OWNER_PASS_FILE.read_text().strip()
    body = json.dumps(
        {'emailOrLdapLoginId': OWNER_EMAIL, 'password': password}
    ).encode()
    request = urllib.request.Request(
        BASE + '/rest/login',
        data=body,
        headers={
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (urtoris-deploy)',
        },
        method='POST',
    )
    with opener.open(request, timeout=60) as response:
        cookies = response.headers.get_all('Set-Cookie') or []
        parsed = json.loads(response.read().decode())
    for cookie in cookies:
        if cookie.startswith('n8n-auth='):
            SESSION_COOKIE = cookie.split(';', 1)[0]
            break
    if not SESSION_COOKIE:
        raise SystemExit('登录成功但没拿到 n8n-auth cookie')
    log(f'已登录 {parsed["data"]["email"]}')
    return parsed['data']['id']


def ensure_credential(name, token):
    """建立/更新一个 httpHeaderAuth 凭证（值 = Bearer <token>）。"""
    status, body = rest('GET', '/rest/credentials')
    existing = None
    if status == 200:
        for item in body.get('data', []):
            if item.get('name') == name:
                existing = item
                break

    payload = {
        'name': name,
        'type': 'httpHeaderAuth',
        'data': {'name': 'Authorization', 'value': f'Bearer {token}'},
    }
    if existing:
        status, body = rest('PATCH', f"/rest/credentials/{existing['id']}", payload)
        action = '更新'
    else:
        status, body = rest('POST', '/rest/credentials', payload)
        action = '创建'
    if status not in (200, 201):
        raise SystemExit(f'{action}凭证失败：HTTP {status} {body}')
    log(f'凭证已{action}：{name}（id={body["data"]["id"]}）')
    return body['data']['id']


def import_workflows(bundle, all_workflows_file):
    log(f'导入 {all_workflows_file} …')
    result = subprocess.run(
        ['n8n', 'import:workflow', f'--input={bundle / all_workflows_file}'],
        cwd='/opt/n8n',
        capture_output=True,
        text=True,
        timeout=300,
    )
    tail = (result.stdout + result.stderr).strip().splitlines()[-3:]
    for line in tail:
        log(line)
    if result.returncode != 0:
        raise SystemExit('导入工作流失败')


def publish(workflow_id):
    status, body = rest('GET', f'/rest/workflows/{workflow_id}')
    if status != 200:
        raise SystemExit(f'读取工作流 {workflow_id} 失败：HTTP {status} {body}')
    version_id = body['data'].get('versionId')
    if not version_id:
        raise SystemExit(f'工作流 {workflow_id} 没有 versionId')
    status, body = rest(
        'POST', f'/rest/workflows/{workflow_id}/activate', {'versionId': version_id}
    )
    if status != 200:
        raise SystemExit(f'发布 {workflow_id} 失败：HTTP {status} {json.dumps(body, ensure_ascii=False)[:400]}')
    return version_id


def verify_webhooks(expected_paths):
    connection = sqlite3.connect(f'file:{N8N_DB}?mode=ro', uri=True)
    rows = connection.execute(
        'SELECT workflowId, webhookPath, method FROM webhook_entity'
    ).fetchall()
    connection.close()
    registered = {row[1]: row[0] for row in rows}
    missing = [path for path in expected_paths if path not in registered]
    return registered, missing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--bundle', required=True)
    parser.add_argument('--phase', default='all')
    parser.add_argument('--webhook-token', required=True)
    parser.add_argument('--internal-token', required=True)
    args = parser.parse_args()

    bundle = Path(args.bundle)
    manifest = json.loads((bundle / 'manifest.json').read_text())
    workflows = json.loads((bundle / 'all-workflows.json').read_text())
    by_id = {item['id']: item for item in workflows}

    print('== 1/5 备份 n8n 数据库 ==')
    backup_database()

    print('== 2/5 写入运维参数并重启 ==')
    # 令牌不写进 .env：n8n 2.x 默认禁止节点读环境变量，而且凭证是加密落库的。
    # 这里只放"运维参数"——execution 数据控制与全局兜底超时。
    env_pairs = {
        # n8n 只监听回环：nginx 和 Urtoris 都从 127.0.0.1 访问它，
        # 绑 0.0.0.0 等于把编辑器挂到公网上，安全组一旦放行 5678 就直接裸奔。
        'N8N_LISTEN_ADDRESS': '127.0.0.1',
        'EXECUTIONS_DATA_PRUNE': 'true',
        'EXECUTIONS_DATA_MAX_AGE': '72',
        'EXECUTIONS_DATA_PRUNE_MAX_COUNT': '2000',
        'EXECUTIONS_DATA_HARD_DELETE_BUFFER': '1',
        'EXECUTIONS_DATA_SAVE_ON_ERROR': 'all',
        # 必须 all：none 会让执行行永远停在 running（详见 build-workflows.mjs 注释）
        'EXECUTIONS_DATA_SAVE_ON_SUCCESS': 'all',
        'EXECUTIONS_DATA_SAVE_ON_PROGRESS': 'false',
        'EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS': 'false',
        # 全局兜底超时：任何工作流都不允许无限挂住
        'EXECUTIONS_TIMEOUT': '90',
        'EXECUTIONS_TIMEOUT_MAX': '180',
    }
    changed = patch_env(env_pairs)
    removed = drop_env([
        'URTORIS_WEBHOOK_TOKEN',
        'URTORIS_INTERNAL_TOKEN',
        'URTORIS_EVENTS_URL',
        'N8N_INTERNAL_BASE_URL',
    ])
    if changed or removed:
        restart_n8n()
    else:
        log('环境变量无变化，跳过重启')
        if not wait_ready(30):
            restart_n8n()

    print('== 3/5 登录 + 建立凭证 ==')
    login()
    credential_id = ensure_credential(
        manifest['containers']['authCredentialName'], args.webhook_token
    )
    internal_credential_id = ensure_credential(
        manifest['containers']['internalCredentialName'], args.internal_token
    )
    log(f'Webhook 凭证 id = {credential_id} / 回传凭证 id = {internal_credential_id}')

    print('== 4/5 导入并按依赖顺序发布 ==')
    import_workflows(bundle, 'all-workflows.json')
    order = manifest['publishOrder']
    for workflow_id in order:
        version = publish(workflow_id)
        name = by_id[workflow_id]['name']
        log(f'已发布 {name}（{workflow_id} @ {version[:8]}）')

    print('== 5/5 核对 webhook 注册表 ==')
    expected = [
        item['webhookPath']
        for item in manifest['workflows']
        if item.get('webhookPath') and item['id'] != manifest['ids']['gateway']
    ]
    expected.append(f"{manifest['webhookPathBase']}/gateway")
    registered, missing = verify_webhooks(expected)
    for path in expected:
        mark = '✓' if path in registered else '✗'
        log(f'{mark} {path} → {registered.get(path, "未注册")}')
    if missing:
        raise SystemExit(f'以下 webhook 未注册：{missing}')

    json.dump(
        {
            'ok': True,
            'credentialId': credential_id,
            'published': order,
            'webhooks': registered,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    print()


if __name__ == '__main__':
    main()
