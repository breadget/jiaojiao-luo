#!/usr/bin/env python3
"""
n8n 数据库回滚演练。

为什么值得真做一次：没被恢复过的备份不算备份。升级 n8n 之前必须先证明
"停服 → 换库 → 起服"这条路径真的能走通，并且耗时可控。

安全性：备份由 tools/remote/n8n_deploy.py 每次部署时自动生成（保留最近 5 份），
演练本身也会把当前库另存为 .predrill 再动手，所以最坏情况也能退回来。
"""

import glob
import json
import os
import shutil
import sqlite3
import subprocess
import time

LIVE = "/root/.n8n/database.sqlite"
BUNDLE = "/tmp/urtoris-bundle"

TABLES = ("workflow_entity", "webhook_entity", "credentials_entity", "execution_entity")


def counts(path):
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    result = {}
    for table in TABLES:
        try:
            result[table] = connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        except sqlite3.OperationalError:
            result[table] = None
    connection.close()
    return result


def health_ok(timeout_seconds=180):
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        done = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
             "http://127.0.0.1:5678/rest/settings"],
            capture_output=True, text=True,
        )
        if done.stdout.strip() == "200":
            return True
        time.sleep(2)
    return False


def main():
    backups = sorted(glob.glob("/root/.n8n/backup-*-predeploy.sqlite"))
    print("可用备份:", [os.path.basename(b) for b in backups])
    if not backups:
        raise SystemExit("没有可用备份，演练中止")

    latest = backups[-1]
    connection = sqlite3.connect(f"file:{latest}?mode=ro", uri=True)
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    connection.close()
    print("最新备份完整性:", integrity)
    if integrity != "ok":
        raise SystemExit("备份文件损坏，演练中止")

    backup_counts = counts(latest)
    live_counts = counts(LIVE)
    print("备份内容:", backup_counts)
    print("当前库内容:", live_counts)

    live_state = json.loads(subprocess.run(
        ["curl", "-s", "http://127.0.0.1:3000/api/state"],
        capture_output=True, text=True,
    ).stdout)
    print("演练前站点工作流数:", len(live_state.get("workflows", [])))

    # ── 执行回滚 ──
    started = time.time()
    subprocess.run(["systemctl", "stop", "n8n"], check=True)
    shutil.copy2(LIVE, LIVE + ".predrill")
    for suffix in ("-wal", "-shm"):
        leftover = LIVE + suffix
        if os.path.exists(leftover):
            os.remove(leftover)
    shutil.copy2(latest, LIVE)
    subprocess.run(["systemctl", "start", "n8n"], check=True)
    ready = health_ok()
    elapsed = time.time() - started
    print(f"回滚完成，n8n 就绪: {ready}，耗时 {elapsed:.1f}s")

    restored_counts = counts(LIVE)
    print("回滚后库内容:", restored_counts)
    matching = all(
        restored_counts[t] == backup_counts[t] for t in TABLES if backup_counts[t] is not None
    )
    print("与备份内容一致:", matching)

    subprocess.run(["systemctl", "restart", "urtoris"], check=False)
    site_ok = False
    for _ in range(30):
        done = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:3000/api/state"],
            capture_output=True, text=True,
        )
        if done.stdout.strip() == "200":
            site_ok = True
            break
        time.sleep(2)
    print("站点恢复:", site_ok)

    print(json.dumps({
        "ok": bool(ready and matching and site_ok),
        "restoreSeconds": round(elapsed, 1),
        "backupCounts": backup_counts,
        "restoredCounts": restored_counts,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
