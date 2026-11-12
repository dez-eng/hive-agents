# -*- coding: utf-8 -*-
"""验证：长上下文 + tools 下，原生 /api/chat 的 think:false 是否仍能可靠关闭思考。

对比两个端点在同一份长请求下的表现：
  A. /v1/chat/completions + reasoning_effort=none   （代理当前做法）
  B. /api/chat          + think=false               （原生硬开关）
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
                "evidence": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "kind": {"type": "string"},
                            "summary": {"type": "string"},
                            "paths": {"type": "array", "items": {"type": "string"}},
                        },
                    },
                },
            },
            "required": ["evidence", "result"],
        },
    },
}]

# 构造一段接近真实规模的历史（约 40KB），模拟 Reasonix 的长对话
FILLER = (
    "以下是项目结构与约定说明。项目使用 Go 语言，目录结构为 cmd/ internal/ pkg/。"
    "所有导出函数需写注释，错误需包装后返回。单元测试放在同级 _test.go 文件。"
    "构建使用 go build ./...，测试使用 go test ./...。禁止使用全局可变状态。"
)
history = [{"role": "system", "content": "你是一个会调用工具的编程助手。"}]
for i in range(120):
    history.append({"role": "user", "content": "[%d] %s" % (i, FILLER)})
    history.append({"role": "assistant", "content": "已了解第 %d 段约定。" % i})

history.append({
    "role": "user",
    "content": "现在请在项目中创建 main.go，内容为 package main 加一个打印 hello 的主函数，并调用 complete_step 标记 plan_step_01 已完成。",
})

size = len(json.dumps(history, ensure_ascii=False))
print("构造历史大小: %.1f KB, 消息数: %d\n" % (size / 1024, len(history)))


def call_v1():
    payload = {
        "model": MODEL,
        "messages": history,
        "tools": TOOLS,
        "max_tokens": 1024,
        "stream": False,
        "reasoning_effort": "none",
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request("http://127.0.0.1:11434/v1/chat/completions",
                                 data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=600) as r:
        data = json.loads(r.read().decode("utf-8"))
    dt = time.time() - t0
    msg = (data.get("choices") or [{}])[0].get("message") or {}
    reasoning = (msg.get("reasoning") or msg.get("thinking") or "").strip()
    calls = msg.get("tool_calls") or []
    usage = data.get("usage") or {}
    print("A. /v1 + reasoning_effort=none")
    print("   耗时 %.1fs | tokens=%s | 思维链=%d 字符 | 工具调用=%d"
          % (dt, usage.get("completion_tokens"), len(reasoning), len(calls)))
    if reasoning:
        print("   思考开头: %s" % reasoning[:200].replace("\n", " "))
    for c in calls:
        print("   -> %s(%s)" % (c["function"]["name"], str(c["function"]["arguments"])[:120]))


def call_native():
    payload = {
        "model": MODEL,
        "messages": history,
        "tools": TOOLS,
        "think": False,
        "stream": False,
        "options": {"num_predict": 1024},
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request("http://127.0.0.1:11434/api/chat",
                                 data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=600) as r:
        data = json.loads(r.read().decode("utf-8"))
    dt = time.time() - t0
    msg = data.get("message") or {}
    content = (msg.get("content") or "").strip()
    thinking = (msg.get("thinking") or "").strip()
    calls = msg.get("tool_calls") or []
    print("\nB. /api/chat + think=false")
    print("   耗时 %.1fs | tokens=%s | thinking=%d 字符 | 正文=%d 字符 | 工具调用=%d"
          % (dt, data.get("eval_count"), len(thinking), len(content), len(calls)))
    if thinking:
        print("   思考开头: %s" % thinking[:200].replace("\n", " "))
    for c in calls:
        fn = c.get("function", {})
        print("   -> %s(%s)" % (fn.get("name"), str(fn.get("arguments"))[:120]))


if __name__ == "__main__":
    call_v1()
    call_native()
