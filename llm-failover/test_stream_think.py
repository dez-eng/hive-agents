# -*- coding: utf-8 -*-
"""验证流式请求下 reasoning_effort=none 是否仍能抑制思考。

Reasonix 实际用的是 stream=true，而之前的测试都是非流式，需要单独确认。
"""
import json
import time
import urllib.request

MODEL = "qwen3:8b"

TOOLS = [{
    "type": "function",
    "function": {
        "name": "complete_step",
        "description": "标记计划步骤完成",
        "parameters": {
            "type": "object",
            "properties": {
                "step_id": {"type": "string"},
                "result": {"type": "string"},
            },
            "required": ["step_id", "result"],
        },
    },
}]

history = [
    {"role": "system", "content": "你是一个会调用工具的助手。"},
    {"role": "user", "content": "创建 main.go 并调用 complete_step 标记 plan_step_01 完成。"},
]

FILLER = "项目使用 Go 语言，目录为 cmd/ internal/ pkg/，导出函数需写注释，错误需包装返回。"
for i in range(80):
    history.insert(-1, {"role": "user", "content": "[%d] %s" % (i, FILLER)})
    history.insert(-1, {"role": "assistant", "content": "已了解。"})

size = len(json.dumps(history, ensure_ascii=False))
print("历史大小: %.1f KB\n" % (size / 1024))


def stream_call(label, extra):
    payload = {
        "model": MODEL,
        "messages": history,
        "tools": TOOLS,
        "max_tokens": 1024,
        "stream": True,
    }
    payload.update(extra)
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request("http://127.0.0.1:11434/v1/chat/completions",
                                 data=body,
                                 headers={"Content-Type": "application/json",
                                          "Accept": "text/event-stream"})
    t0 = time.time()
    reasoning_chars = 0
    content_chars = 0
    tool_buf = {}
    events = 0

    with urllib.request.urlopen(req, timeout=600) as r:
        for raw in r:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            data_str = line[5:].strip()
            if data_str == "[DONE]":
                break
            try:
                chunk = json.loads(data_str)
            except Exception:
                continue
            events += 1
            delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
            if delta.get("reasoning"):
                reasoning_chars += len(delta["reasoning"])
            if delta.get("content"):
                content_chars += len(delta["content"])
            for tc in (delta.get("tool_calls") or []):
                idx = tc.get("index", 0)
                fn = tc.get("function") or {}
                slot = tool_buf.setdefault(idx, {"name": "", "args": ""})
                if fn.get("name"):
                    slot["name"] += fn["name"]
                if fn.get("arguments"):
                    slot["args"] += fn["arguments"]

    dt = time.time() - t0
    print("%s" % label)
    print("  耗时 %.1fs | SSE 事件 %d | reasoning %d 字符 | content %d 字符 | 工具调用 %d"
          % (dt, events, reasoning_chars, content_chars, len(tool_buf)))
    for idx in sorted(tool_buf):
        s = tool_buf[idx]
        print("  -> %s(%s)" % (s["name"], s["args"][:150]))
    print()


if __name__ == "__main__":
    stream_call("A. 流式 + reasoning_effort=none", {"reasoning_effort": "none"})
    stream_call("B. 流式 + 无任何抑制参数（对照）", {})
