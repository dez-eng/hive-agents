# -*- coding: utf-8 -*-
"""对比三个本地模型在工具调用上的 schema 遵循质量。

背景：qwen3:8b 实测只填 {"step":"plan_step_01"}，缺 result/evidence，
且重复调用两次。工具报错 -> 模型重试 -> 上下文累积 -> 看起来像"一直重复思考"。
"""
import json
import time
import urllib.request

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
                    "description": "完成证据，至少一项",
                    "items": {
                        "type": "object",
                        "properties": {
                            "kind": {"type": "string", "description": "files|verification|diff|manual"},
                            "summary": {"type": "string"},
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

MESSAGES = [
    {"role": "system", "content": "你是一个会调用工具的编程助手。调用工具时必须严格遵守 schema 的 required 字段。"},
    {"role": "user", "content": "我刚创建了 main.go 文件。请调用 complete_step 标记 plan_step_01 已完成，证据填文件路径。"},
]

MODELS = [
    ("qwen3:8b", "A. 8B（当前 agent 档）"),
    ("qwen3-coder:30b", "B. Coder-30B"),
    ("qwen3:30b-a3b-thinking-2507-q4_K_M", "C. 30B-Thinking"),
]


def run(model, label):
    payload = {
        "model": model,
        "messages": MESSAGES,
        "tools": TOOLS,
        "max_tokens": 512,
        "stream": False,
        "temperature": 0.2,
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request("http://127.0.0.1:11434/v1/chat/completions",
                                 data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print("%s -> ERROR: %s\n" % (label, e))
        return
    dt = time.time() - t0

    msg = (data.get("choices") or [{}])[0].get("message") or {}
    calls = msg.get("tool_calls") or []
    reasoning = (msg.get("reasoning") or "").strip()
    usage = data.get("usage") or {}

    print("%s  (耗时 %.1fs, tokens=%s, 思考 %d 字符)"
          % (label, dt, usage.get("completion_tokens"), len(reasoning)))

    ok_any = False
    for c in calls:
        fn = c.get("function", {})
        args_raw = fn.get("arguments")
        try:
            args = json.loads(args_raw) if isinstance(args_raw, str) else (args_raw or {})
        except Exception:
            args = {}
        missing = [k for k in ("evidence", "result") if k not in args]
        status = "OK" if not missing else "缺 " + ",".join(missing)
        if not missing:
            ok_any = True
        print("   %s 参数=%s" % (status, json.dumps(args, ensure_ascii=False)[:180]))

    if not calls:
        print("   未产生工具调用；正文: %s" % (msg.get("content") or "")[:150])
    print("   调用次数=%d  %s" % (len(calls), "参数合格" if ok_any else "参数不合格"))
    print()


if __name__ == "__main__":
    for model, label in MODELS:
        run(model, label)
