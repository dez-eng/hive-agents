# -*- coding: utf-8 -*-
"""端到端验证：读取 Reasonix 的 DEEPSEEK_API_KEY，经 failover 代理调用云端。"""
import json
import os
import time
import urllib.request

PROXY = os.environ.get("PROXY_URL", "http://127.0.0.1:11500/v1/chat/completions")

# 找 key 的顺序：环境变量 → 本目录 .env → ~/.hive/.env
# 不写死任何机器上的绝对路径。
ENV_CANDIDATES = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"),
    os.path.join(os.path.expanduser("~"), ".hive", ".env"),
    os.path.join(os.getcwd(), ".env"),
]


def load_key():
    key = os.environ.get("DEEPSEEK_API_KEY")
    if key:
        return key.strip()
    for path in ENV_CANDIDATES:
        if not os.path.exists(path):
            continue
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if line.startswith("DEEPSEEK_API_KEY"):
                    line = line.split("=", 1)[1].strip()
                    return line.strip('"').strip("'")
    return None


key = load_key()
if not key:
    print("未找到 DEEPSEEK_API_KEY")
    raise SystemExit(1)

print("API key 已读取: %s...%s (长度 %d)" % (key[:6], key[-4:], len(key)))

payload = {
    "model": "deepseek-v4-flash",
    "messages": [{"role": "user", "content": "只回答两个字：正常"}],
    "max_tokens": 32,
    "stream": False,
}
body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
req = urllib.request.Request(
    PROXY, data=body,
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
)

t0 = time.time()
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
        mode = r.headers.get("X-LLM-Mode", "?")
        status = r.status
except Exception as e:
    print("请求失败:", e)
    raise SystemExit(1)

dt = time.time() - t0
try:
    data = json.loads(raw.decode("utf-8"))
except Exception:
    print("原始响应:", raw[:400])
    raise SystemExit(1)

if "error" in data:
    print("上游返回错误:", json.dumps(data["error"], ensure_ascii=False)[:300])
    raise SystemExit(1)

content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content", "")
usage = data.get("usage") or {}
print("HTTP=%s  X-LLM-Mode=%s  耗时=%.1fs" % (status, mode, dt))
print("云端 model=%s" % data.get("model", "?"))
print("回答: %s" % content.strip()[:200])
print("token 用量: prompt=%s completion=%s" % (usage.get("prompt_tokens"), usage.get("completion_tokens")))
