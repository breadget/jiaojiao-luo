#!/usr/bin/env python3
"""Bounded ingress checks; the temporary upload canary is removed immediately."""
import argparse
import base64
import collections
import concurrent.futures
import hashlib
import hmac
import http.client
import json
from pathlib import Path
import re
import secrets
import shutil
import socket
import ssl
import subprocess
import time


parser = argparse.ArgumentParser()
parser.add_argument('--staged', action='store_true')
parser.add_argument('--live', action='store_true')
args = parser.parse_args()
if args.staged == args.live:
    parser.error('Choose exactly one of --staged or --live.')
http_port, https_port = (18080, 18443) if args.staged else (80, 443)


def fetch(path, host='urtoris.cn', method='GET', headers=None, body=None, secure=True, client='203.0.113.80'):
    # Curl provides normal certificate/SNI validation while connecting directly
    # to this server, avoiding the workstation's proxy DNS and edge cache.
    port = https_port if secure else http_port
    url = f'{"https" if secure else "http"}://{host}:{port}{path}'
    command = ['curl', '--noproxy', '*', '--silent', '--show-error', '--connect-timeout', '3', '--max-time', '12',
               '--resolve', f'{host}:{port}:127.0.0.1', '--request', method, '--dump-header', '-', url]
    combined = dict(headers or {})
    if args.staged:
        combined['X-Urtoris-Audit-IP'] = client
    for key, value in combined.items():
        command += ['--header', key + ': ' + value]
    if body is not None:
        command += ['--data-binary', '@-']
    result = subprocess.run(command, input=body, capture_output=True, timeout=15)
    output = result.stdout.decode('utf-8', errors='replace')
    head, _, content = output.partition('\r\n\r\n')
    match = re.search(r'^HTTP/\S+ (\d+)', head)
    while match and 100 <= int(match[1]) < 200:
        head, _, content = content.partition('\r\n\r\n')
        match = re.search(r'^HTTP/\S+ (\d+)', head)
    status = int(match[1]) if match else 0
    response_headers = {}
    for line in head.splitlines()[1:]:
        if ':' in line:
            key, value = line.split(':', 1)
            response_headers[key.lower()] = value.strip()
    if result.returncode and not (result.returncode in (52, 56) and status == 0):
        raise RuntimeError(result.stderr.decode()[-500:])
    return status, response_headers, content


def expect(label, result, statuses):
    status, headers, body = result
    if status not in statuses:
        raise AssertionError(f'{label}: expected {statuses}, got {status}')
    print(json.dumps({'check': label, 'status': status}, ensure_ascii=False))
    return headers, body


def check_upload():
    # Use a valid short-lived capability so the worker reads the whole request;
    # an early unauthorized response can reset an unread large HTTP body.
    values = {}
    for line in Path('/opt/urtoris/app/.dev.vars').read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip().strip('\"').strip("'")
    task = 'task_' + secrets.token_hex(16)
    unsigned = f'{task}.{int(time.time() * 1000) + 60_000}.{secrets.token_hex(16)}'
    signature = base64.urlsafe_b64encode(hmac.new(values['PYTHON_TASK_SIGNING_KEY'].encode(), unsigned.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    task_dir = Path('/var/lib/urtoris-python-executor/data/tasks') / task
    assert not task_dir.exists()
    def connect():
        connection = http.client.HTTPConnection('urtoris.cn', https_port, timeout=15)
        connection.sock = ssl.create_default_context().wrap_socket(
            socket.create_connection(('127.0.0.1', https_port), timeout=15), server_hostname='urtoris.cn')
        return connection
    headers = {
        'Host': 'urtoris.cn', 'Content-Type': 'application/octet-stream',
        'Authorization': 'Bearer ' + values['URTORIS_API_TOKEN'],
        'X-Urtoris-Task-Token': unsigned + '.' + signature,
    }
    if args.staged:
        headers['X-Urtoris-Audit-IP'] = '203.0.113.80'
    # HTML readiness is insufficient: verify the freshly started worker's
    # authenticated connection to the executor before declaring it ready.
    for attempt in range(10):
        connection = connect()
        try:
            connection.request('GET', '/api/python/runs?taskId=' + task, headers=headers)
            response = connection.getresponse()
            response.read()
            if response.status == 200:
                break
            if response.status not in (502, 503, 504):
                raise AssertionError(f'Executor readiness failed: {response.status}')
        finally:
            connection.close()
        time.sleep(1)
    else:
        raise AssertionError('The website could not reach its executor after restart.')
    print(json.dumps({'check': 'website to executor readiness', 'status': 200}))
    connection = connect()
    try:
        connection.request('POST', '/api/python/files?taskId=' + task + '&name=protection-canary.txt',
                           body=b'x' * 1048577, headers=headers)
        response = connection.getresponse()
        payload = response.read()
        if response.status != 201:
            try:
                error = json.loads(payload).get('error', '')
            except (ValueError, AttributeError):
                error = 'Non-JSON error response'
            raise AssertionError(f'Authenticated upload failed: {response.status}: {error}')
        uploaded = list(task_dir.glob('input/*/content'))
        assert len(uploaded) == 1 and uploaded[0].stat().st_size == 1048577
        print(json.dumps({'check': 'authenticated upload above JSON limit', 'status': response.status, 'bytes': 1048577}))
    finally:
        connection.close()
        if task_dir.exists():
            shutil.rmtree(task_dir)


# A service restart may take a few seconds to accept requests.
for attempt in range(20):
    try:
        home = fetch('/')
        if home[0] == 200:
            break
    except RuntimeError:
        pass
    time.sleep(1)
else:
    raise AssertionError('Homepage did not become healthy.')
headers, html = expect('homepage', home, {200})
for header in ['x-content-type-options', 'x-frame-options', 'content-security-policy', 'strict-transport-security', 'referrer-policy']:
    assert headers.get(header), header
assert headers.get('server') == 'nginx', 'Server version must not be exposed.'
expect('studio', fetch('/studio'), {200})
_, body = expect('state', fetch('/api/state', headers={
    'X-Forwarded-Host': 'localhost', 'X-Real-IP': '127.0.0.1', 'CF-Connecting-IP': '127.0.0.1',
}), {200})
assert json.loads(body)['adminTrusted'] is False
expect('HTTP redirects to HTTPS', fetch('/', secure=False), {301})
expect('unknown HTTP host', fetch('/', host='scanner.invalid', secure=False), {0})
expect('unknown TLS host', fetch('/', headers={'Host': 'scanner.invalid'}), {0})
for path in ['/.env', '/.git/config', '/index.php', '/cgi-bin/test', '/app.js.map', '/api/local-control/status']:
    expect('blocked ' + path, fetch(path), {404})
expect('TRACE rejected', fetch('/', method='TRACE'), {405})
expect('unused server actions rejected', fetch('/', method='POST', headers={'Next-Action': 'x'}, body=b'{}'), {400})
expect('page POST rejected', fetch('/studio', method='POST', body=b'{}'), {405})
expect('admin token required', fetch('/api/workflows/wf_n8n_llm_smoke/graph'), {401})
expect('forged cross-origin headers', fetch('/api/llm/models', method='POST', headers={
    'Origin': 'https://scanner.invalid', 'X-Forwarded-Host': 'scanner.invalid',
    'X-Forwarded-Proto': 'https', 'Content-Type': 'application/json',
}, body=b'{}'), {403})
expect('oversized JSON stopped at ingress', fetch('/api/llm/models', method='POST', headers={
    'Content-Length': '1048577', 'Content-Type': 'application/json',
}, body=b'{}'), {413})
check_upload()

if args.staged:
    expect('n8n public editor denied', fetch('/', host='n8n.urtoris.cn', secure=False), {403})
    expect('n8n public REST denied', fetch('/rest/settings', host='n8n.urtoris.cn', secure=False), {403})
    # Stage-only source rewrite is omitted to verify local administration.
    expect('n8n local editor', fetch('/', host='n8n.urtoris.cn', secure=False, client='127.0.0.1'), {200})
    expect('n8n webhook still requires authentication', fetch('/webhook/urtoris/llm-smoke',
        host='n8n.urtoris.cn', secure=False, method='POST', headers={'Content-Type': 'application/json'}, body=b'{}'), {401, 403})

    def expensive_probe(index):
        # An empty request cannot execute a workflow; it normally returns 400.
        return fetch('/api/agent/chat', method='POST', headers={
            'CF-Connecting-IP': f'198.51.100.{index + 1}',
            'Origin': 'https://urtoris.cn', 'Content-Type': 'application/json',
        }, body=b'{}', client='203.0.113.200')
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        probes = list(pool.map(expensive_probe, range(12)))
    blocked = [r for r in probes if r[0] == 429]
    print(json.dumps({'check': 'burst response counts', 'statuses': dict(collections.Counter(r[0] for r in probes))}))
    assert blocked and any(r[0] == 400 for r in probes) and all(r[0] in (400, 429) for r in probes)
    assert all(r[1].get('retry-after') and r[1].get('x-content-type-options') for r in blocked)
    print(json.dumps({'check': 'forged IP burst throttled', 'requests': 12, 'blocked': len(blocked)}))
    asset = re.search(r'(?:src|href)="(/_next/static/[^"\s]+\.js)"', html)
    assert asset, 'Homepage has no JS bundle reference.'
    for _ in range(24):
        assert fetch(asset[1], client='203.0.113.200')[0] == 200
    print(json.dumps({'check': 'static bundles available while API is throttled', 'requests': 24, 'status': 200}))

print('Ingress protection checks passed.')
