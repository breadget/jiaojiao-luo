#!/usr/bin/env python3
"""Stage, verify and atomically install the Urtoris production ingress policy."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def run(*args):
    subprocess.run(args, check=True)


def atomic_write(path, content, metadata=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.urtoris-protection-')
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(content)
        os.chmod(temporary, metadata.st_mode & 0o777 if metadata else 0o644)
        if metadata:
            os.chown(temporary, metadata.st_uid, metadata.st_gid)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Run this installer as root on the Aliyun production host.')
    source = Path(__file__).resolve().parent
    files = {
        '/etc/nginx/conf.d/urtoris-limits.conf': source / 'nginx/urtoris-protection.conf',
        '/etc/nginx/sites-available/urtoris.cn': source / 'urtoris.nginx.conf',
        '/etc/nginx/sites-available/n8n': source / 'n8n/nginx-http.conf',
        '/etc/nginx/sites-available/n8n-ip': source / 'nginx/urtoris-default-deny.conf',
    }
    for name in ['urtoris-proxy', 'urtoris-site-guard', 'urtoris-security-headers']:
        files[f'/etc/nginx/snippets/{name}.conf'] = source / f'nginx/{name}.conf'
    for target, candidate in files.items():
        if not candidate.is_file():
            raise SystemExit('Missing policy source: ' + str(candidate))
        if Path(target).is_symlink():
            raise SystemExit('Refusing to replace symlinked policy file: ' + target)
    expected_sites = {'urtoris.cn', 'n8n', 'n8n-ip'}
    if {p.name for p in Path('/etc/nginx/sites-enabled').iterdir()} != expected_sites:
        raise SystemExit('The enabled sites differ from the audited production layout.')

    # All candidate tests run on loopback ports with a separate Nginx process.
    # The audit-only real-IP header allows testing a public client ACL safely;
    # it is never installed into production.
    with tempfile.TemporaryDirectory(prefix='urtoris-ingress-check-') as temporary:
        staging = Path(temporary)
        staging.chmod(0o755)
        for target, candidate in files.items():
            dest = staging / target.lstrip('/')
            dest.parent.mkdir(parents=True, exist_ok=True)
            content = candidate.read_text().replace('/etc/nginx/snippets/', str(staging / 'etc/nginx/snippets') + '/')
            content = re.sub(r'listen (?:\[::\]:)?443 ssl(?: default_server)?;', '', content)
            if target.endswith('urtoris.cn'):
                content = content.replace('server {', 'server {\n    listen 127.0.0.1:18443 ssl;', 1)
            elif target.endswith('n8n-ip'):
                # Keep one HTTP and one HTTPS default server for test host routing.
                last = content.rfind('server {')
                content = content[:last] + content[last:].replace('server {', 'server {\n    listen 127.0.0.1:18443 ssl default_server;', 1)
            content = content.replace('listen [::]:80 default_server;', '').replace('listen [::]:80;', '')
            content = content.replace('listen 80 default_server;', 'listen 127.0.0.1:18080 default_server;')
            content = content.replace('listen 80;', 'listen 127.0.0.1:18080;')
            dest.write_text(content)
            dest.chmod(0o644)
        config = staging / 'nginx.conf'
        config.write_text(
            f'pid {staging}/nginx.pid;\nerror_log {staging}/error.log warn;\n'
            'events { worker_connections 128; }\nhttp {\n'
            'include /etc/nginx/mime.types;\ndefault_type application/octet-stream;\n'
            f'access_log {staging}/access.log;\n'
            'set_real_ip_from 127.0.0.1;\nreal_ip_header X-Urtoris-Audit-IP;\n'
            f'include {staging}/etc/nginx/conf.d/*.conf;\n'
            f'include {staging}/etc/nginx/sites-available/*;\n}}\n'
        )
        run('nginx', '-t', '-c', str(config))
        run('nginx', '-c', str(config))
        try:
            run('python3', str(source / 'nginx/check-protection.py'), '--staged')
        except subprocess.CalledProcessError:
            print((staging / 'error.log').read_text()[-4_000:], flush=True)
            raise
        finally:
            run('nginx', '-s', 'quit', '-c', str(config))
        if args.check_only:
            print('Candidate policy passed; production configuration was not modified.')
            return

    backup = Path('/opt/urtoris/backups') / ('site-protection-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700)
    env_file = Path('/opt/urtoris/app/.dev.vars')
    targets = [Path(name) for name in files] + [env_file]
    states = {}
    for path in targets:
        metadata = path.stat() if path.exists() else None
        states[path] = metadata
        if metadata:
            dest = backup / str(path).lstrip('/')
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, dest)
            dest.chmod(0o600)
    (backup / 'manifest.json').write_text(json.dumps({str(p): p.exists() for p in targets}))
    changed = []
    try:
        for target, candidate in files.items():
            path = Path(target)
            atomic_write(path, candidate.read_bytes(), states[path])
            changed.append(path)
        run('nginx', '-t')
        env = re.sub(r'^URTORIS_ADMIN_TRUST_LOCAL=.*\n?', '', env_file.read_text(), flags=re.M)
        atomic_write(env_file, (env.rstrip() + '\nURTORIS_ADMIN_TRUST_LOCAL=0\n').encode(), states[env_file])
        changed.append(env_file)
        run('systemctl', 'reload', 'nginx')
        run('systemctl', 'restart', 'urtoris')
        run('python3', str(source / 'nginx/check-protection.py'), '--live')
    except BaseException:
        for path in reversed(changed):
            saved = backup / str(path).lstrip('/')
            if saved.exists():
                atomic_write(path, saved.read_bytes(), states[path])
            else:
                path.unlink(missing_ok=True)
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        run('systemctl', 'restart', 'urtoris')
        raise
    print('Protection installed and verified. Rollback snapshot: ' + str(backup))


if __name__ == '__main__':
    main()
