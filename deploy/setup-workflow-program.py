#!/usr/bin/env python3
"""Prepare the loopback program service without starting or deploying it.

Run as root from the new source checkout even when /opt/urtoris/app still holds
an older release. Secrets are generated/read in memory and written atomically;
they are never printed or passed to a child process.
"""

import grp
import hmac
import os
from pathlib import Path
import pwd
import re
import secrets
import stat
import subprocess
import sys
import tempfile


APP_DIR = Path('/opt/urtoris/app')
STATE_DIR = Path('/var/lib/urtoris-workflow-program')
ENV_FILE = Path('/etc/urtoris/workflow-program.env')
UNIT_FILE = Path('/etc/systemd/system/urtoris-workflow-program.service')
UNIT_SOURCE = Path(__file__).with_name('urtoris-workflow-program.service')
TOKEN_PATTERN = re.compile(r'[A-Za-z0-9._~+/=-]{32,4096}')


def regular(path):
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode) or path.resolve() != path.absolute():
        raise ValueError('Expected a regular file without symlinks.')
    return path.read_text()


def settings(content):
    values = {}
    for line in content.splitlines():
        if line.startswith(('WORKFLOW_PROGRAM_TOKEN=', 'WORKFLOW_PROGRAM_URL=', 'WORKFLOW_PROGRAM_PORT=', 'WORKFLOW_PROGRAM_STATE_DIR=')):
            name, value = line.split('=', 1)
            if name in values:
                raise ValueError('Duplicate workflow program configuration.')
            values[name] = value.strip().strip('"').strip("'")
    return values


def safe_directory(path, uid, gid, mode):
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not path.is_dir() or path.resolve() != path.absolute():
            raise ValueError('Unsafe program service directory.')
    else:
        if path.parent.resolve() != path.parent.absolute():
            raise ValueError('Unsafe program service directory parent.')
        path.mkdir(mode=mode)
    os.chown(path, uid, gid)
    os.chmod(path, mode)


def atomic_file(path, content, uid, gid, mode):
    if path.exists() or path.is_symlink():
        regular(path)
    descriptor, temporary = tempfile.mkstemp(prefix='.program-setup-', dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        os.fchown(descriptor, uid, gid)
        with os.fdopen(descriptor, 'w') as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def prepare():
    # Validate the existing site's private file before creating any server state.
    site_file = APP_DIR / '.dev.vars'
    site_content = regular(site_file)
    site_values = settings(site_content)
    worker_content = regular(ENV_FILE) if ENV_FILE.exists() or ENV_FILE.is_symlink() else ''
    worker_values = settings(worker_content)
    site_token = site_values.get('WORKFLOW_PROGRAM_TOKEN', '')
    worker_token = worker_values.get('WORKFLOW_PROGRAM_TOKEN', '')
    for token in (site_token, worker_token):
        if token and not TOKEN_PATTERN.fullmatch(token):
            raise ValueError('Existing workflow program token is invalid; it was not changed.')
    if site_token and worker_token and not hmac.compare_digest(site_token, worker_token):
        raise ValueError('Existing site and worker tokens differ; neither token was changed.')
    token = worker_token or site_token or secrets.token_hex(32)
    unit_content = regular(UNIT_SOURCE)
    application = pwd.getpwnam('urtoris')
    group = grp.getgrnam('urtoris')
    try:
        worker = pwd.getpwnam('urtoris-program')
        if worker.pw_gid != group.gr_gid:
            raise ValueError('urtoris-program must use the urtoris group.')
    except KeyError:
        subprocess.run(['useradd', '--system', '--no-create-home', '--home-dir', str(STATE_DIR),
                        '--shell', '/usr/sbin/nologin', '--gid', 'urtoris', 'urtoris-program'], check=True)
        worker = pwd.getpwnam('urtoris-program')
    safe_directory(STATE_DIR, worker.pw_uid, group.gr_gid, 0o700)
    safe_directory(ENV_FILE.parent, 0, group.gr_gid, 0o750)
    if not UNIT_FILE.parent.is_dir() or UNIT_FILE.parent.resolve() != UNIT_FILE.parent.absolute():
        raise ValueError('Expected a regular systemd unit directory.')
    worker_lines = [line for line in worker_content.splitlines()
                    if not line.startswith(('WORKFLOW_PROGRAM_TOKEN=', 'WORKFLOW_PROGRAM_PORT=', 'WORKFLOW_PROGRAM_STATE_DIR='))]
    worker_lines.extend([f'WORKFLOW_PROGRAM_TOKEN={token}', 'WORKFLOW_PROGRAM_PORT=8030', f'WORKFLOW_PROGRAM_STATE_DIR={STATE_DIR}'])
    atomic_file(ENV_FILE, '\n'.join(worker_lines) + '\n', 0, group.gr_gid, 0o640)
    site_lines = [line for line in site_content.splitlines()
                  if not line.startswith(('WORKFLOW_PROGRAM_TOKEN=', 'WORKFLOW_PROGRAM_URL='))]
    site_lines.extend(['WORKFLOW_PROGRAM_URL=http://127.0.0.1:8030', f'WORKFLOW_PROGRAM_TOKEN={token}'])
    atomic_file(site_file, '\n'.join(site_lines) + '\n', application.pw_uid, group.gr_gid, 0o600)
    atomic_file(UNIT_FILE, unit_content, 0, 0, 0o644)
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', 'urtoris-workflow-program.service'], check=True)
    print('Workflow program service prepared. The worker and website were not started or restarted.')
    print('The next verified runtime deployment will start the worker and check its local health.')


def main():
    if os.geteuid() != 0:
        print('Run this preparation script as root.', file=sys.stderr)
        return 77
    if len(sys.argv) != 1:
        print('Usage: python3 deploy/setup-workflow-program.py', file=sys.stderr)
        return 64
    try:
        prepare()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError):
        # Do not expose paths containing configuration material or exception reprs.
        print('Program service preparation failed. Check the private configuration, user/group and directory permissions. No service was started.', file=sys.stderr)
        return 78
    return 0


if __name__ == '__main__':
    sys.exit(main())
