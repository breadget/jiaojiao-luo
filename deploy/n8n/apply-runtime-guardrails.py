#!/usr/bin/env python3
"""Apply reversible n8n runtime guardrails on the existing ECS instance."""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import time


ENV_PATH = pathlib.Path('/opt/n8n/.env')
BACKUP_ROOT = pathlib.Path('/var/backups/n8n')
WEBHOOK_PROBE_URL = 'http://127.0.0.1:5678/webhook/urtoris/llm-smoke'
UPDATES = {
    # Urtoris uses production webhooks and the local CLI, not n8n's public API.
    'N8N_PUBLIC_API_DISABLED': 'true',
    'N8N_PUBLIC_API_SWAGGERUI_DISABLED': 'true',
    # No community packages are installed on this instance.
    'N8N_COMMUNITY_PACKAGES_ENABLED': 'false',
    # Keep the production editor from contacting the public template service.
    'N8N_TEMPLATES_ENABLED': 'false',
    'N8N_DIAGNOSTICS_ENABLED': 'false',
}


def wait_until_healthy() -> None:
    for _ in range(45):
        ready = subprocess.run(
            ['curl', '-fsS', 'http://127.0.0.1:5678/healthz/readiness'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        webhook = subprocess.run(
            [
                'curl',
                '-sS',
                '-o',
                '/dev/null',
                '-w',
                '%{http_code}',
                '-X',
                'POST',
                WEBHOOK_PROBE_URL,
                '-H',
                'Content-Type: application/json',
                '--data-binary',
                '{}',
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if ready.returncode == 0 and webhook.stdout.strip() in {'401', '403'}:
            return
        time.sleep(1)
    raise RuntimeError('n8n did not register the W1 webhook within 45 seconds')


def main() -> int:
    if os.geteuid() != 0:
        raise PermissionError('run this script as root')
    if not ENV_PATH.is_file():
        raise FileNotFoundError(ENV_PATH)

    stamp = time.strftime('%Y%m%d-%H%M%S')
    backup = BACKUP_ROOT / f'audit-hardening-{stamp}'
    backup.mkdir(parents=True, mode=0o700)
    shutil.copy2(ENV_PATH, backup / 'n8n.env')
    (backup / 'n8n.env').chmod(0o600)

    lines = []
    for line in ENV_PATH.read_text().splitlines():
        key = line.split('=', 1)[0]
        if key not in UPDATES:
            lines.append(line)
    lines.extend(f'{key}={value}' for key, value in UPDATES.items())

    temporary = ENV_PATH.with_name('.env.guardrails-new')
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    with os.fdopen(descriptor, 'w') as file:
        file.write('\n'.join(lines) + '\n')

    try:
        temporary.replace(ENV_PATH)
        ENV_PATH.chmod(0o600)
        subprocess.run(['systemctl', 'restart', 'n8n'], check=True)
        wait_until_healthy()
    except Exception:
        if temporary.exists():
            temporary.unlink()
        shutil.copy2(backup / 'n8n.env', ENV_PATH)
        ENV_PATH.chmod(0o600)
        subprocess.run(['systemctl', 'restart', 'n8n'], check=True)
        wait_until_healthy()
        raise

    print(json.dumps({'ok': True, 'backup': str(backup), 'updates': UPDATES}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
