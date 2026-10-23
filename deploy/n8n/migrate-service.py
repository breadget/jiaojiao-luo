"""Run as root on the existing ECS, after reviewing the deployment bundle."""
import os
import pathlib
import shutil
import subprocess
import time


def wait_until_ready() -> None:
    for _ in range(45):
        readiness = subprocess.run(
            ['curl', '-fsS', 'http://127.0.0.1:5678/healthz/readiness'],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        webhook = subprocess.run(
            [
                'curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}',
                '-X', 'POST',
                'http://127.0.0.1:5678/webhook/urtoris/llm-smoke',
                '-H', 'Content-Type: application/json',
                '--data-binary', '{}',
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if readiness.returncode == 0 and webhook.stdout.strip() in {'401', '403'}:
            return
        time.sleep(1)
    raise RuntimeError('n8n did not register the W1 webhook within 45 seconds')


base = pathlib.Path('/opt/n8n')
stage = base / 'https-staging'
source = pathlib.Path('/root/.n8n')
target = pathlib.Path('/var/lib/n8n/.n8n')
backup = pathlib.Path('/var/backups/n8n') / time.strftime('%Y%m%d-%H%M%S')
assert os.geteuid() == 0
assert source.is_dir() and not target.exists(), 'Migration already done or data path unexpected'
backup.mkdir(parents=True, mode=0o700)
backup.parent.chmod(0o700)
for src, name in [(base / '.env', 'n8n.env'),
                  (pathlib.Path('/etc/systemd/system/n8n.service'), 'n8n.service'),
                  (pathlib.Path('/etc/nginx/sites-available/n8n'), 'nginx-n8n.conf')]:
    shutil.copy2(src, backup / name)
    (backup / name).chmod(0o600)

subprocess.run(['systemctl', 'stop', 'n8n'], check=True)
try:
    shutil.copytree(source, backup / 'data')
    try:
        subprocess.run(['id', 'n8n'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        subprocess.run(['useradd', '--system', '--create-home', '--home-dir', '/var/lib/n8n',
                        '--shell', '/usr/sbin/nologin', 'n8n'], check=True)
    shutil.copytree(source, target)
    subprocess.run(['chown', '-R', 'n8n:n8n', '/var/lib/n8n'], check=True)
    pathlib.Path('/var/lib/n8n').chmod(0o700)
    target.chmod(0o700)
    updates = {
        'N8N_HOST': 'n8n.urtoris.cn',
        'N8N_LISTEN_ADDRESS': '127.0.0.1',
        'N8N_PROTOCOL': 'https',
        'N8N_PORT': '5678',
        'N8N_EDITOR_BASE_URL': 'https://n8n.urtoris.cn/',
        'WEBHOOK_URL': 'https://n8n.urtoris.cn/',
        'N8N_PROXY_HOPS': '1',
        'N8N_SECURE_COOKIE': 'true',
        'N8N_USER_FOLDER': '/var/lib/n8n',
        'N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS': 'true',
        'N8N_SSRF_PROTECTION_ENABLED': 'true',
        'N8N_PUBLIC_API_DISABLED': 'true',
        'N8N_PUBLIC_API_SWAGGERUI_DISABLED': 'true',
        'N8N_COMMUNITY_PACKAGES_ENABLED': 'false',
        'N8N_TEMPLATES_ENABLED': 'false',
        'N8N_DIAGNOSTICS_ENABLED': 'false',
        'EXECUTIONS_DATA_PRUNE': 'true',
        # n8n 2.35.7 can leave execution_entity rows in "running" when
        # successful execution data is disabled. Keep success metadata/data
        # until an upgraded version passes the finalization canary, then rely
        # on short retention and count pruning to bound SQLite growth.
        'EXECUTIONS_DATA_SAVE_ON_ERROR': 'all',
        'EXECUTIONS_DATA_SAVE_ON_SUCCESS': 'all',
        'EXECUTIONS_DATA_SAVE_ON_PROGRESS': 'false',
        'EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS': 'false',
        'EXECUTIONS_DATA_MAX_AGE': '72',
        'EXECUTIONS_DATA_PRUNE_MAX_COUNT': '2000',
    }
    lines = []
    for line in (base / '.env').read_text().splitlines():
        key = line.split('=', 1)[0]
        if key not in updates and key not in {
            'N8N_SKIP_WEBHOOK_DEREGISTRATION_SHUTDOWN',
            'N8N_WEBHOOK_URL',
        }:
            lines.append(line)
    lines.extend(f'{key}={value}' for key, value in updates.items())
    temp = base / '.env.https-new'
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as file:
        file.write('\n'.join(lines) + '\n')
    temp.replace(base / '.env')
    shutil.copyfile(stage / 'n8n.service', '/etc/systemd/system/n8n.service')
    shutil.copyfile(stage / 'nginx-https.conf', '/etc/nginx/sites-available/n8n')
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'start', 'n8n'], check=True)
    wait_until_ready()
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
except Exception:
    shutil.copy2(backup / 'n8n.env', base / '.env')
    shutil.copy2(backup / 'n8n.service', '/etc/systemd/system/n8n.service')
    shutil.copy2(backup / 'nginx-n8n.conf', '/etc/nginx/sites-available/n8n')
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'restart', 'n8n'], check=True)
    wait_until_ready()
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    raise
print(f'Backup saved at {backup}; service migrated to n8n user with HTTPS configuration.')
