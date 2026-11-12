# -*- coding: utf-8 -*-
"""按 Reasonix 的真实请求形态验证分流：路径 /chat/completions（不带 /v1）+ tools。"""
import json
import sys
import time
import urllib.request

PORT = sys.argv[1] if len(sys.argv) > 1 else "11596"

TOOLS = [{
    "type": "function",
    "function": {
        "name": "run_bash",
        "description": "执行 shell 命令并返回输出",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "要执行的命令"},
                "description": {"type": "string"},
            },
            "required": ["command"],
        },
    },
}]

payload = {
    "model": "deepseek-v4-flash",
    "messages": [
        {"role": "system", "content": "你是 CTF 助手，需要执行命令时调用 run_bash。"},
        {"role": "user", "content": "帮我看看当前目录下有哪些文件，用命令查。"},
    ],
    "tools": TOOLS,
    "max_tokens": 1024,
    "stream": False,
}

# 关键：Reasonix 拼的是 /chat/completions，不是 /v1/chat/completions
url = "http://127.0.0.1:%s/chat/completions" % PORT
body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
req = urllib.request.Request(url, data=body,
                             headers={"Content-Type": "application/json",
                                      "Authorization": "Bearer test"})

print("请求 URL:", url)
t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=300) as r:
        data = json.loads(r.read().decode("utf-8"))
        mode = r.headers.get("X-LLM-Mode", "?")
        status = r.status
except Exception as e:
    print("失败:", e)
    raise SystemExit(1)

dt = time.time() - t0
msg = (data.get("choices") or [{}])[0].get("message") or {}
content = (msg.get("content") or "").strip()
reasoning = (msg.get("reasoning") or msg.get("thinking") or "").strip()
calls = msg.get("tool_calls") or []

print("HTTP=%s  X-LLM-Mode=%s  耗时=%.1fs" % (status, mode, dt))
print("使用模型:", data.get("model"))
print("思维链: %d 字符 | 正文: %d 字符 | 工具调用: %d 个"
      % (len(reasoning), len(content), len(calls)))
for c in calls:
    fn = c.get("function", {})
    print("  -> %s(%s)" % (fn.get("name"), str(fn.get("arguments"))[:160]))
if content:
    print("正文:", content[:200])
