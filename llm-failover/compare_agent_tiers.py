# -*- coding: utf-8 -*-
"""对比 Thinking-only 模型与 hybrid 模型在工具调用场景下的行为。

复现问题：Thinking 模型面对工具 schema 时会陷入元认知循环，
反复重读 required 字段、自我怀疑，最后输出占位值。

运行：
    python compare_agent_tiers.py
"""
import json
import time
import urllib.request

URL = "http://127.0.0.1:11434/v1/chat/completions"

TOOLS = [{
    "type": "function",
    "function": {
        "name": "complete_step",
        "description": "标记计划中的一个步骤已完成。",
        "parameters": {
            "type": "object",
            "properties": {
                "step_id": {"type": "string", "description": "步骤标识"},
                "result": {"type": "string", "description": "完成后为真的事情"},
                "evidence": {
                    "type": "array",
                    "description": "完成证据",
                    "items": {
                        "type": "object",
                        "properties": {
                            "kind": {"type": "string"},
                            "summary": {"type": "string"},
                            "command": {"type": "string"},
                            "paths": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["kind", "summary"],
                    },
                },
            },
            "required": ["evidence", "result"],
        },
    },
}]

# 故意制造一次"参数校验失败后需要修正"的场景——正是用户遇到的元认知陷阱
MESSAGES = [
    {"role": "system", "content": "你是一个会调用工具的助手。工具调用必须严格遵守 schema。"},
    {"role": "user", "content": "请调用 complete_step 标记 step_01 已完成。"},
    {"role": "assistant", "content": None, "tool_calls": [{
        "id": "call_1", "type": "function",
        "function": {"name": "complete_step", "arguments": '{"step_id":"step_01"}'},
    }]},
    {"role": "tool", "tool_call_id": "call_1",
     "content": 'invalid arguments for complete_step; it requires "result"; it accepts "evidence", "notes", "result", "step", "step_id", "step_index"'},
]


def run(model, label, extra=None):
    payload = {
        "model": model,
        "messages": MESSAGES,
        "tools": TOOLS,
        "max_tokens": 2048,
        "stream": False,
        "temperature": 0.3,
    }
    if extra:
        payload.update(extra)

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(URL, data=body,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print("%-28s ERROR: %s" % (label, e))
        return
    dt = time.time() - t0

    usage = data.get("usage") or {}
    msg = (data.get("choices") or [{}])[0].get("message") or {}
    content = (msg.get("content") or "")
    reasoning = (msg.get("reasoning") or msg.get("thinking") or "")
    calls = msg.get("tool_calls") or []

    print("=" * 72)
    print("%s  (%s)" % (label, model))
    if extra:
        print("附加参数: %s" % json.dumps(extra, ensure_ascii=False))
    print("耗时 %.1fs | tokens=%s | 思维链=%d 字符 | 正文=%d 字符 | 工具调用=%d 个"
          % (dt, usage.get("completion_tokens"), len(reasoning), len(content), len(calls)))
    if calls:
        for c in calls:
            fn = c.get("function", {})
            print("  -> %s(%s)" % (fn.get("name"), fn.get("arguments")))
    if content.strip():
        print("  正文: %s" % content.strip()[:300].replace("\n", " "))
    if reasoning.strip():
        head = reasoning.strip()[:400].replace("\n", " ")
        print("  思维链开头: %s..." % head)
        tail = reasoning.strip()[-300:].replace("\n", " ")
        print("  思维链结尾: ...%s" % tail)
    print()


if __name__ == "__main__":
    print("测试场景：工具参数校验失败后，模型需要自行修正并重新调用\n")

    run("qwen3:30b-a3b-thinking-2507-q4_K_M", "A. Thinking-only（当前默认）")
    run("qwen3:8b", "B. Hybrid 默认")
    run("qwen3:8b", "C. Hybrid + think=false", {"think": False})
