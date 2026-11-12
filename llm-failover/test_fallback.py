# -*- coding: utf-8 -*-
"""验证 failover 代理对 UTF-8 中文请求的处理（模拟 Reasonix 真实请求）。"""
import json
import sys
import time
import urllib.request

PORT = sys.argv[1] if len(sys.argv) > 1 else "11501"
URL = "http://127.0.0.1:%s/v1/chat/completions" % PORT

payload = {
    "model": "deepseek-v4-flash",
    "messages": [
        {"role": "system", "content": "你是一个 CTF 助手。"},
        {"role": "user", "content": "用一句话说明：什么是 SQL 注入？"},
    ],
    "max_tokens": 200,
    "stream": False,
    "temperature": 0.3,
}

body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
req = urllib.request.Request(
    URL, data=body,
    headers={"Content-Type": "application/json", "Authorization": "Bearer test"},
)

t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read()
        mode = r.headers.get("X-LLM-Mode", "?")
        status = r.status
except Exception as e:
    print("请求失败:", e)
    sys.exit(1)

dt = time.time() - t0
try:
    data = json.loads(raw.decode("utf-8"))
except Exception:
    data = {}

choice = (data.get("choices") or [{}])[0]
msg = choice.get("message") or {}
content = msg.get("content") or ""
model_used = data.get("model", "?")

print("HTTP=%s  X-LLM-Mode=%s  耗时=%.1fs" % (status, mode, dt))
print("实际 model=%s" % model_used)
print("回答长度=%d 字符" % len(content))
print("-" * 60)
print(content[:800])
