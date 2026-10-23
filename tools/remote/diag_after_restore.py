import json
import sqlite3
import subprocess
import time

TOKEN = open("/tmp/urtoris-bundle/token.txt").read().strip()
N8N = "http://127.0.0.1:5678"

body = {
    "protocol": "urtoris.v1",
    "requestId": "postroll-" + str(int(time.time())),
    "workflowId": "llm-smoke",
    "sessionId": "s1",
    "message": "回滚后连通性测试",
    "user": {"id": "t"},
    "context": {},
    "meta": {"source": "diag", "sentAt": int(time.time() * 1000), "attempt": 1,
             "timeoutMs": 45000, "idempotencyKey": "diag"},
}

started = time.time()
result = subprocess.run(
    ["curl", "-s", "-m", "40", "-o", "/tmp/diag_resp.txt", "-w", "%{http_code}",
     "-X", "POST", f"{N8N}/webhook/urtoris/llm-smoke",
     "-H", "Content-Type: application/json",
     "-H", f"Authorization: Bearer {TOKEN}",
     "-d", json.dumps(body)],
    capture_output=True, text=True,
)
print("HTTP", result.stdout.strip(), f"耗时 {time.time()-started:.1f}s")
print("响应体:", open("/tmp/diag_resp.txt").read()[:400])

db = sqlite3.connect("/root/.n8n/database.sqlite")
db.row_factory = sqlite3.Row
print("\n最近执行:")
for r in db.execute("SELECT id, workflowId, status, startedAt FROM execution_entity ORDER BY id DESC LIMIT 6"):
    print("  ", r["id"], r["workflowId"], r["status"], r["startedAt"])

print("\n卡在 running 的执行总数:",
      db.execute("SELECT COUNT(*) FROM execution_entity WHERE status = 'running'").fetchone()[0])
