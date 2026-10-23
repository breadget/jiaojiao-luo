#!/usr/bin/env python3
"""Patch exported Urtoris workflows without exposing credentials or inline config.

Run this on the ECS against a fresh ``n8n export:workflow --published --separate``
directory. It writes a new directory and never mutates the export in place.
"""

from __future__ import annotations

import argparse
import copy
import json
import pathlib
import sys
import uuid


TOP_LEVEL = {
    "urtoris-wf-llm-smoke": True,
    "urtoris-wf-user-manager": True,
    "urtoris-wf-security-analysis": False,
    "urtoris-wf-api-gateway": False,
    "urtoris-wf-customer-insights": True,
}
GATEWAY_ID = "urtoris-gateway"
COMMON_ENVELOPE_ID = "urtoris-common-envelope"
COMMON_LOG_ID = "urtoris-common-log"

START_NODE = "建立 executionId 映射"
POST_NODE = "上报执行映射"
RESTORE_NODE = "恢复 Webhook 请求"
MODE_NODE = "标记执行模式"
DEFAULT_MODE_NODE = "补齐模式字段"


def load_workflow(path: pathlib.Path) -> dict:
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or not isinstance(value.get("nodes"), list):
        raise ValueError(f"{path.name}: expected one exported workflow object")
    return value


def find_node(workflow: dict, name: str) -> dict:
    matches = [node for node in workflow["nodes"] if node.get("name") == name]
    if len(matches) != 1:
        raise ValueError(
            f"{workflow.get('id')}: expected exactly one node named {name!r}"
        )
    return matches[0]


def code_node(template: dict, name: str, position: list[int], js_code: str) -> dict:
    node = copy.deepcopy(template)
    node["id"] = str(uuid.uuid4())
    node["name"] = name
    node["position"] = position
    node["parameters"] = {
        "mode": "runOnceForAllItems",
        "language": "javaScript",
        "jsCode": js_code,
    }
    node.pop("credentials", None)
    node.pop("disabled", None)
    node.pop("onError", None)
    node.pop("continueOnFail", None)
    return node


def edge(node_name: str) -> dict:
    return {"node": node_name, "type": "main", "index": 0}


def splice_after(workflow: dict, source: str, inserted: str) -> None:
    connections = workflow.setdefault("connections", {})
    current = connections.get(source)
    if not current or not current.get("main"):
        connections[source] = {"main": [[edge(inserted)]]}
        return
    old_outputs = current["main"]
    connections[source] = {"main": [[edge(inserted)]]}
    connections[inserted] = {"main": old_outputs}


def add_early_binding(workflow: dict, http_template: dict) -> None:
    existing_names = {node.get("name") for node in workflow["nodes"]}
    if {START_NODE, POST_NODE, RESTORE_NODE} & existing_names:
        raise ValueError(f"{workflow.get('id')}: binding nodes already exist")

    webhook = find_node(workflow, "Webhook")
    original = find_node(workflow, next(
        item["node"]
        for output in workflow["connections"]["Webhook"]["main"]
        for item in output
    ))
    code_template = original if original.get("type") == "n8n-nodes-base.code" else find_node(workflow, "Webhook")
    if code_template.get("type") != "n8n-nodes-base.code":
        code_template = next(
            node for node in workflow["nodes"] if node.get("type") == "n8n-nodes-base.code"
        )

    webhook_position = webhook.get("position", [-880, 0])
    workflow_name = json.dumps(workflow.get("name", workflow.get("id", "")), ensure_ascii=False)
    start_code = f"""const incoming = $('Webhook').first().json;
const body = incoming.body ?? incoming;
const headers = incoming.headers ?? {{}};
const requestId = body.requestId ?? headers['x-urtoris-request-id'] ?? null;
const sessionId = body.sessionId ?? headers['x-urtoris-session-id'] ?? null;
return [{{ json: {{
  eventType: 'execution.bound',
  level: 'info',
  message: 'requestId 与 executionId 已在入口绑定',
  requestId,
  sessionId,
  workflowId: body.workflowId ?? null,
  workflow: body.meta?.workflowName ?? {workflow_name},
  executionId: $execution.id,
  payload: {{ stage: 'accepted' }}
}} }}];"""
    restore_code = """const incoming = $('Webhook').first().json;
return [{ json: incoming }];"""

    start = code_node(
        code_template,
        START_NODE,
        [webhook_position[0] + 220, webhook_position[1] - 360],
        start_code,
    )
    post = copy.deepcopy(http_template)
    post["id"] = str(uuid.uuid4())
    post["name"] = POST_NODE
    post["position"] = [webhook_position[0] + 440, webhook_position[1] - 360]
    # common-log 里的原节点会引用「构建事件」的输出；复制到主工作流后
    # 必须改为上报当前映射节点的 JSON，否则会被 onError 吞掉而不落库。
    post["parameters"]["sendBody"] = True
    post["parameters"]["specifyBody"] = "json"
    post["parameters"]["jsonBody"] = "={{ $json }}"
    # The binding is the safety gate: a non-2xx response from the site must
    # stop the workflow before any downstream node can run.
    post.pop("onError", None)
    post.pop("continueOnFail", None)
    restore = code_node(
        code_template,
        RESTORE_NODE,
        [webhook_position[0] + 660, webhook_position[1] - 360],
        restore_code,
    )

    old_outputs = workflow["connections"]["Webhook"]["main"]
    workflow["nodes"].extend([start, post, restore])
    workflow["connections"]["Webhook"] = {"main": [[edge(START_NODE)]]}
    workflow["connections"][START_NODE] = {"main": [[edge(POST_NODE)]]}
    workflow["connections"][POST_NODE] = {"main": [[edge(RESTORE_NODE)]]}
    workflow["connections"][RESTORE_NODE] = {"main": old_outputs}


def add_mode_marker(workflow: dict, llm_optional: bool) -> None:
    if MODE_NODE in {node.get("name") for node in workflow["nodes"]}:
        raise ValueError(f"{workflow.get('id')}: mode node already exists")
    envelope = find_node(workflow, "common-envelope")
    code_template = next(
        node for node in workflow["nodes"] if node.get("type") == "n8n-nodes-base.code"
    )
    if llm_optional:
        mode_logic = """const incoming = $('Webhook').first().json;
const body = incoming.body ?? incoming;
const apiKey = body.context?.llm?.apiKey;
const hasLlmKey = typeof apiKey === 'string' && apiKey.trim().length > 0;
envelope.mode = hasLlmKey ? 'llm' : 'rules';
envelope.degraded = !hasLlmKey;"""
    else:
        mode_logic = """envelope.mode = 'rules';
envelope.degraded = false;"""
    marker = code_node(
        code_template,
        MODE_NODE,
        [envelope.get("position", [700, 0])[0] + 110, envelope.get("position", [700, 0])[1] + 180],
        f"""const envelope = {{ ...$input.first().json }};
{mode_logic}
return [{{ json: envelope }}];""",
    )
    workflow["nodes"].append(marker)
    splice_after(workflow, "common-envelope", MODE_NODE)


def add_w1_rule_fallback(workflow: dict) -> None:
    """Treat an absent BYO key as an explicit rules success in the smoke workflow."""
    node = find_node(workflow, "透传模型错误")
    original = node.get("parameters", {}).get("jsCode")
    if not isinstance(original, str) or not original.strip():
        raise ValueError("W1 model error node has no JavaScript code")
    sentinel = "URTORIS_RULES_FALLBACK_V1"
    if sentinel in original:
        raise ValueError("W1 rules fallback is already present")
    prefix = f"""// {sentinel}
const __urtorisResult = $input.first().json;
const __urtorisError = __urtorisResult.error ?? __urtorisResult;
const __urtorisCode = __urtorisError.code ?? __urtorisError.errorCode ?? null;
if (__urtorisCode === 'LLM_NOT_CONFIGURED') {{
  const __urtorisIncoming = $('Webhook').first().json;
  const __urtorisBody = __urtorisIncoming.body ?? __urtorisIncoming;
  return [{{ json: {{
    ok: true,
    requestId: __urtorisBody.requestId ?? null,
    sessionId: __urtorisBody.sessionId ?? null,
    workflowId: __urtorisBody.workflowId ?? 'llm-smoke',
    workflow: __urtorisBody.workflowId ?? 'llm-smoke',
    message: '未配置模型 Key；规则连通性检查已完成。',
    reply: '规则模式运行正常。填入 Key 后可切换到真实模型。',
    mode: 'rules',
    degraded: true,
    fallback: true,
    checks: {{ requestAccepted: true, llmConfigured: false }}
  }} }}];
}}
"""
    node["parameters"]["jsCode"] = prefix + original


def add_default_mode(workflow: dict, source_name: str) -> None:
    if DEFAULT_MODE_NODE in {node.get("name") for node in workflow["nodes"]}:
        raise ValueError(f"{workflow.get('id')}: default mode node already exists")
    source = find_node(workflow, source_name)
    code_template = next(
        node for node in workflow["nodes"] if node.get("type") == "n8n-nodes-base.code"
    )
    marker = code_node(
        code_template,
        DEFAULT_MODE_NODE,
        [source.get("position", [0, 0])[0] + 220, source.get("position", [0, 0])[1] + 180],
        """const envelope = { ...$input.first().json };
if (!['llm', 'rules', 'simulated'].includes(envelope.mode)) envelope.mode = 'rules';
if (typeof envelope.degraded !== 'boolean') envelope.degraded = false;
return [{ json: envelope }];""",
    )
    workflow["nodes"].append(marker)
    splice_after(workflow, source_name, DEFAULT_MODE_NODE)


def validate(workflow: dict) -> None:
    node_names = [node.get("name") for node in workflow["nodes"]]
    if len(node_names) != len(set(node_names)):
        raise ValueError(f"{workflow.get('id')}: duplicate node names")
    for source, outputs in workflow.get("connections", {}).items():
        if source not in node_names:
            raise ValueError(f"{workflow.get('id')}: missing connection source {source!r}")
        for branch in outputs.get("main", []):
            for target in branch:
                if target.get("node") not in node_names:
                    raise ValueError(
                        f"{workflow.get('id')}: missing connection target {target.get('node')!r}"
                    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError(f"output directory already exists: {args.output}")
    args.output.mkdir(parents=True, mode=0o700)

    paths = sorted(args.source.glob("*.json"))
    workflows = {load_workflow(path)["id"]: (path, load_workflow(path)) for path in paths}
    missing = (set(TOP_LEVEL) | {GATEWAY_ID, COMMON_ENVELOPE_ID, COMMON_LOG_ID}) - set(workflows)
    if missing:
        raise ValueError(f"missing workflows: {', '.join(sorted(missing))}")

    common_log = workflows[COMMON_LOG_ID][1]
    http_template = find_node(common_log, "上报 Urtoris")
    if http_template.get("type") != "n8n-nodes-base.httpRequest":
        raise ValueError("common-log reporting node is not an HTTP Request node")

    changed: list[str] = []
    for workflow_id, llm_optional in TOP_LEVEL.items():
        workflow = workflows[workflow_id][1]
        add_early_binding(workflow, http_template)
        add_mode_marker(workflow, llm_optional)
        if workflow_id == "urtoris-wf-llm-smoke":
            add_w1_rule_fallback(workflow)
        changed.append(workflow_id)

    gateway = workflows[GATEWAY_ID][1]
    add_early_binding(gateway, http_template)
    add_default_mode(gateway, "归并网关结果")
    changed.append(GATEWAY_ID)

    common_envelope = workflows[COMMON_ENVELOPE_ID][1]
    add_default_mode(common_envelope, "构建信封")
    changed.append(COMMON_ENVELOPE_ID)

    for workflow_id, (source_path, workflow) in workflows.items():
        validate(workflow)
        destination = args.output / source_path.name
        destination.write_text(json.dumps(workflow, ensure_ascii=False, indent=2) + "\n")
        destination.chmod(0o600)

    print(
        json.dumps(
            {
                "ok": True,
                "exported": len(workflows),
                "patched": sorted(changed),
                "output": str(args.output),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise
