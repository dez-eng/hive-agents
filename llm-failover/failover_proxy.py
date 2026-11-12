#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
LLM Failover Proxy
==================
Reasonix -> http://127.0.0.1:11500/v1 -> 云端 api.deepseek.com
                                      -> 断网/超时/5xx 时自动改发本地 Ollama

特性:
  * 流式响应透传（SSE 不缓冲）
  * 云端失败自动切换本地，后台每 30 秒探测云端，恢复后自动切回
  * 本地模式下自动改写 model 名
  * 本地上下文窗口远小于云端，超长请求自动裁剪并注入提示
  * /__status 端点可查当前状态

环境变量:
  UPSTREAM_URL     云端基址，默认 https://api.deepseek.com
  LOCAL_URL        本地基址，默认 http://127.0.0.1:11434/v1
  LOCAL_MODEL      本地模型名，默认 qwen3:30b-a3b-thinking-2507-q4_K_M
  LISTEN_PORT      监听端口，默认 11500
  PROBE_INTERVAL   云端探测间隔秒，默认 30
  LOCAL_CTX_CHARS  本地可用上下文字符数，默认 45000（约 16K tokens）
  CONNECT_TIMEOUT  连接超时秒，默认 10
  READ_TIMEOUT     读超时秒，默认 180
  FORCE_STATE      测试用：cloud / local，强制初始状态
"""
import json
import os
import subprocess
import sys
import threading
import time
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

UPSTREAM = os.environ.get("UPSTREAM_URL", "https://api.deepseek.com").rstrip("/")
# 2026-11-12: 本地模型改为经按需网关（~/ollama-stealth/gateway.py）访问。
# 网关在首个请求时拉起 ollama，空闲到期后连同 ollama 一并退出；
# 因此本地回退不再假定 11434 常驻，也不直连 ollama。
LOCAL = os.environ.get("LOCAL_URL", "http://127.0.0.1:11501/v1").rstrip("/")
LOCAL_MODEL = os.environ.get("LOCAL_MODEL", "deepseek-r1:14b")
# 工具调用档：小模型里 qwen3:8b 现为本机唯一可用的非思考型候选。
# 历史实测（已删的 30B 模型）见 git 记录；qwen3:8b 慢但能产出工具调用。
LOCAL_MODEL_AGENT = os.environ.get("LOCAL_MODEL_AGENT", "qwen3:8b")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "11500"))
PROBE_INTERVAL = int(os.environ.get("PROBE_INTERVAL", "30"))
LOCAL_CTX_CHARS = int(os.environ.get("LOCAL_CTX_CHARS", "45000"))
# agent 档上下文预算：长历史会显著拉高小模型退化概率，砍半处理
AGENT_CTX_CHARS = int(os.environ.get("AGENT_CTX_CHARS", "20000"))
LOCAL_MIN_TOKENS = int(os.environ.get("LOCAL_MIN_TOKENS", "6144"))
# agent 档输出上限：工具调用不需要长输出，给太多空间会助长重复退化
AGENT_MAX_TOKENS = int(os.environ.get("AGENT_MAX_TOKENS", "2048"))
CONNECT_TIMEOUT = int(os.environ.get("CONNECT_TIMEOUT", "10"))
READ_TIMEOUT = int(os.environ.get("READ_TIMEOUT", "180"))

_HERE = os.path.dirname(os.path.abspath(__file__))
# 主实例与测试实例分开写日志，否则临时端口的记录会混进主日志造成误判
_LOG_NAME = "failover.log" if LISTEN_PORT == 11500 else "failover-%d.log" % LISTEN_PORT
LOG_PATH = os.path.join(_HERE, _LOG_NAME)

# 本地网关（按需唤醒）的 token：与 reasonix 的 LOCAL_LLM_KEY 同源，均为
# ~/ollama-stealth/token。缺 token 时网关会返回 401，本地回退不可用。
_GW_TOKEN_PATH = os.path.join(os.path.expanduser("~"), "ollama-stealth", "token")
_GW_LLMCTL = os.path.join(os.path.expanduser("~"), "ollama-stealth", "llmctl.ps1")


def gw_token():
    try:
        with open(_GW_TOKEN_PATH, encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def ensure_gateway():
    """网关未监听时拉起它（网关自己再按需拉起 ollama）。"""
    parts = urlsplit(LOCAL)
    host, port = parts.hostname or "127.0.0.1", parts.port or 80
    try:
        conn = http.client.HTTPConnection(host, port, timeout=2)
        conn.connect()
        conn.close()
        return True
    except Exception:
        pass
    log("本地网关未就绪，拉起 %s" % _GW_LLMCTL)
    try:
        subprocess.Popen(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", _GW_LLMCTL, "start"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception as e:
        log("拉起网关失败: %s" % e)
        return False
    # 网关是轻量 Python 进程，通常 1~2 秒内就绪
    for _ in range(20):
        time.sleep(0.5)
        try:
            conn = http.client.HTTPConnection(host, port, timeout=2)
            conn.connect()
            conn.close()
            log("本地网关已就绪")
            return True
        except Exception:
            continue
    log("本地网关拉起超时")
    return False

_state = {
    "mode": os.environ.get("FORCE_STATE", "cloud"),   # cloud | local
    "since": time.time(),
    "reason": "startup",
    "switches": 0,
}
_lock = threading.Lock()


def log(msg):
    line = "[%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def get_mode():
    with _lock:
        return _state["mode"]


def set_mode(mode, reason):
    with _lock:
        if _state["mode"] == mode:
            return False
        old = _state["mode"]
        _state["mode"] = mode
        _state["since"] = time.time()
        _state["reason"] = reason
        _state["switches"] += 1
    log("状态切换: %s -> %s (%s)" % (old, mode, reason))
    return True


def split_url(base):
    """把 https://host/path 拆成 (scheme, host, port, prefix)"""
    p = urlsplit(base)
    scheme = p.scheme or "http"
    host = p.hostname or "127.0.0.1"
    port = p.port or (443 if scheme == "https" else 80)
    prefix = p.path.rstrip("/")
    return scheme, host, port, prefix


UP_SCHEME, UP_HOST, UP_PORT, UP_PREFIX = split_url(UPSTREAM)
LO_SCHEME, LO_HOST, LO_PORT, LO_PREFIX = split_url(LOCAL)


def probe_upstream():
    """探测云端是否可达。任何 2xx/3xx/401/403/404 都算可达（说明网络通）。"""
    global UP_SCHEME, UP_HOST, UP_PORT, UP_PREFIX
    try:
        conn_cls = http.client.HTTPSConnection if UP_SCHEME == "https" else http.client.HTTPConnection
        conn = conn_cls(UP_HOST, UP_PORT, timeout=CONNECT_TIMEOUT)
        try:
            conn.request("GET", (UP_PREFIX or "") + "/models")
            resp = conn.getresponse()
            resp.read(256)
            # 401 也说明网络可达（只是没带 key）
            return True
        finally:
            conn.close()
    except Exception:
        return False


def watchdog():
    """后台探测线程：本地模式下若云端恢复则切回。"""
    while True:
        time.sleep(PROBE_INTERVAL)
        if get_mode() != "local":
            continue
        if probe_upstream():
            set_mode("cloud", "云端探测成功，自动恢复")
        else:
            log("云端仍不可达，继续使用本地模型")


def trim_messages(payload, limit=None):
    """本地上下文远小于云端，超限时保留 system + 最近消息。"""
    limit = limit or LOCAL_CTX_CHARS
    msgs = payload.get("messages")
    if not isinstance(msgs, list) or not msgs:
        return payload, 0

    def size_of(seq):
        return len(json.dumps(seq, ensure_ascii=False))

    if size_of(msgs) <= limit:
        return payload, 0

    system = [m for m in msgs if m.get("role") == "system"]
    rest = [m for m in msgs if m.get("role") != "system"]

    kept = []
    total = size_of(system)
    for m in reversed(rest):
        s = size_of([m])
        if total + s > limit * 0.85:
            break
        kept.insert(0, m)
        total += s

    dropped = len(rest) - len(kept)
    note = {
        "role": "system",
        "content": ("[断网降级提示] 你正在本地小模型上运行，上下文窗口有限，"
                    "已省略 %d 条较早的对话记录。回答时请基于现有信息，"
                    "如缺少关键上下文请直接说明。" % dropped),
    }
    payload = dict(payload)
    payload["messages"] = system + [note] + kept
    return payload, dropped


def is_degenerated(buf, n=60, repeat=4):
    """检测输出是否陷入重复退化。

    小模型在长上下文下会反复输出同一段内容（常见于 </answer> 之类的格式标签
    之后），直到把 token 预算烧完。做法：在最近一小段窗口内统计 n-gram 频次，
    任一 60 字符片段重复出现 4 次即判定退化。
    """
    span = n * repeat * 2
    if len(buf) < n * repeat:
        return False
    tail = buf[-span:]
    grams = {}
    for i in range(len(tail) - n + 1):
        g = tail[i:i + n]
        if not g.strip():
            continue
        c = grams.get(g, 0) + 1
        if c >= repeat:
            return True
        grams[g] = c
    return False


def rewrite_for_local(payload):
    """本地模式下改写 model 名并裁剪上下文。

    按请求特征分两档：
      * 带 tools（agent / 工具调用）-> LOCAL_MODEL_AGENT（代码模型，无 thinking）
      * 不带 tools（问答 / 分析）-> LOCAL_MODEL（Thinking 档），保留思维链
    """
    payload = dict(payload)

    has_tools = bool(payload.get("tools"))
    if has_tools:
        payload["model"] = LOCAL_MODEL_AGENT
        # 代码模型本身无 thinking，无需 reasoning_effort 抑制
        payload["reasoning_effort"] = "none"
        payload.pop("think", None)
        # 工具调用不需要长输出；给太多空间反而助长重复退化
        mt = payload.get("max_tokens") or payload.get("max_completion_tokens")
        if mt is None or int(mt) > AGENT_MAX_TOKENS:
            payload["max_tokens"] = AGENT_MAX_TOKENS
            payload.pop("max_completion_tokens", None)
    else:
        payload["model"] = LOCAL_MODEL
        payload.pop("think", None)
        payload.pop("reasoning_effort", None)
        mt = payload.get("max_tokens") or payload.get("max_completion_tokens")
        if mt is None or int(mt) < LOCAL_MIN_TOKENS:
            payload["max_tokens"] = LOCAL_MIN_TOKENS
            payload.pop("max_completion_tokens", None)

    # 退化止血：模型陷入循环时常见以这些标签收尾，命中即停
    stops = list(payload.get("stop") or [])
    for s in ("</answer>", "</final_answer>", "\\end{answer}", "<|im_end|>"):
        if s not in stops:
            stops.append(s)
    payload["stop"] = stops

    payload, dropped = trim_messages(
        payload, AGENT_CTX_CHARS if has_tools else LOCAL_CTX_CHARS)

    # Thinking 模型会先消耗大量 token 产出思维链；沿用云端的 max_tokens
    # （常见 512~2048）会导致最终答案为空的假成功。这里强制抬高下限。
    mt = payload.get("max_tokens")
    if mt is None:
        mt = payload.get("max_completion_tokens")
    if mt is None or int(mt) < LOCAL_MIN_TOKENS:
        payload["max_tokens"] = LOCAL_MIN_TOKENS
        payload.pop("max_completion_tokens", None)

    # Ollama 对部分云端专有字段不认，保守清理
    for k in ("logprobs", "top_logprobs", "logit_bias"):
        payload.pop(k, None)
    return payload, dropped


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "LLMFailover/1.0"

    def log_message(self, fmt, *args):
        pass  # 静默，改用自建日志

    # ---------- 状态端点 ----------
    def do_GET(self):
        if self.path.rstrip("/") in ("/__status", "/status"):
            with _lock:
                body = json.dumps({
                    "mode": _state["mode"],
                    "since": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(_state["since"])),
                    "reason": _state["reason"],
                    "switches": _state["switches"],
                    "upstream": UPSTREAM,
                    "local": LOCAL,
                    "local_model": LOCAL_MODEL,
                }, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        # 其余 GET 透传（/v1/models 等）
        self._forward(b"")

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        self._forward(body)

    # ---------- 核心转发 ----------
    def _forward(self, body):
        mode = get_mode()
        if mode == "cloud":
            ok = self._try_forward("cloud", body)
            if ok:
                return
            set_mode("local", "云端请求失败（连接/超时/5xx），自动降级")
            log("降级到本地模型重试")
        # 本地模式
        self._try_forward("local", body, is_fallback=True)

    def _try_forward(self, mode, body, is_fallback=False):
        if mode == "cloud":
            scheme, host, port, prefix = UP_SCHEME, UP_HOST, UP_PORT, UP_PREFIX
        else:
            scheme, host, port, prefix = LO_SCHEME, LO_HOST, LO_PORT, LO_PREFIX

        payload = None
        if body:
            try:
                payload = json.loads(body.decode("utf-8"))
            except Exception:
                payload = None

        dropped = 0
        if mode == "local" and isinstance(payload, dict):
            payload, dropped = rewrite_for_local(payload)
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            tier = "agent(关思考)" if payload.get("tools") else "analysis(思维链)"
            log("[local] 档位=%s model=%s (body %d 字节)" % (tier, payload.get("model"), len(body)))
        elif mode == "local":
            log("[local] 警告：payload 非 dict (body %d 字节)，未改写 model；原始内容=%r" % (len(body), body[:300]))

        # 拼接上游路径：若上游基址自带路径前缀（如本地 /v1），避免重复拼接
        path = self.path
        if prefix and not path.startswith(prefix + "/") and path != prefix:
            path = prefix + path
        headers = {}
        for k, v in self.headers.items():
            lk = k.lower()
            if lk in ("host", "content-length", "connection", "accept-encoding"):
                continue
            headers[k] = v
        headers["Content-Length"] = str(len(body))
        if mode == "local":
            # 网关要求 Bearer token；缺 token 会被 401 拒绝
            headers["Authorization"] = "Bearer " + gw_token()

        conn_cls = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
        conn = conn_cls(host, port, timeout=CONNECT_TIMEOUT)
        try:
            conn.connect()
        except Exception as e:
            log("[%s] 连接失败 %s:%s -> %s" % (mode, host, port, e))
            try:
                conn.close()
            except Exception:
                pass
            if mode == "cloud":
                return False
            # 闲置态下网关是退出的，拉起后重试一次
            if ensure_gateway():
                conn = conn_cls(host, port, timeout=CONNECT_TIMEOUT)
                try:
                    conn.connect()
                except Exception as e2:
                    self._send_error(502, "本地模型服务不可达: %s" % e2)
                    return True
            else:
                self._send_error(502, "本地模型服务不可达: %s" % e)
                return True

        try:
            try:
                conn.putrequest("POST" if body else "GET", path, skip_host=False)
            except Exception:
                conn.putrequest("POST" if body else "GET", path)
            for k, v in headers.items():
                conn.putheader(k, v)
            conn.endheaders()
            if body:
                conn.send(body)
        except Exception as e:
            log("[%s] 发送请求失败: %s" % (mode, e))
            conn.close()
            if mode == "cloud":
                return False
            self._send_error(502, "本地模型请求失败: %s" % e)
            return True

        # 等响应头（读超时按 READ_TIMEOUT）
        conn.sock.settimeout(READ_TIMEOUT)
        try:
            resp = conn.getresponse()
        except Exception as e:
            log("[%s] 等待响应失败: %s" % (mode, e))
            conn.close()
            if mode == "cloud":
                return False
            self._send_error(504, "本地模型响应超时: %s" % e)
            return True

        status = resp.status
        if mode == "cloud" and (status >= 500 or status == 429):
            log("[cloud] 上游返回 %d，判定为不可用" % status)
            try:
                resp.read()
            except Exception:
                pass
            conn.close()
            return False

        if is_fallback and dropped:
            log("降级模式：已裁剪 %d 条历史消息以适配本地上下文" % dropped)

        # 判断是否流式请求
        is_stream = True
        if isinstance(payload, dict):
            is_stream = bool(payload.get("stream", False))

        # 本地 + 非流式：先缓冲，若最终答案被思维链挤空则回填
        if mode == "local" and not is_stream:
            raw = resp.read()
            try:
                data = json.loads(raw.decode("utf-8"))
                chs = data.get("choices") or []
                if chs:
                    msg = chs[0].get("message") or {}
                    if not (msg.get("content") or "").strip() and (msg.get("thinking") or "").strip():
                        msg["content"] = msg["thinking"].strip()
                        chs[0]["message"] = msg
                        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
                        log("[local] 最终答案为空，已用思维链内容回填")
            except Exception as e:
                log("[local] 响应后处理失败: %s" % e)
            try:
                self.send_response(status)
                for k, v in resp.getheaders():
                    if k.lower() in ("content-type", "cache-control", "x-request-id"):
                        self.send_header(k, v)
                self.send_header("X-LLM-Mode", "local-fallback")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
                self.wfile.flush()
            except Exception as e:
                log("[local] 回写响应失败: %s" % e)
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
            return True

        # 回写响应头，开始流式透传
        self.send_response(status)
        passthrough = ("content-type", "cache-control", "x-request-id")
        for k, v in resp.getheaders():
            if k.lower() in passthrough:
                self.send_header(k, v)
        if mode == "local":
            self.send_header("X-LLM-Mode", "local-fallback")
        else:
            self.send_header("X-LLM-Mode", "cloud")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        text_buf = []
        linebuf = ""
        degenerated = False
        try:
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                self.wfile.write(b"%X\r\n" % len(chunk))
                self.wfile.write(chunk)
                self.wfile.write(b"\r\n")
                self.wfile.flush()

                # 本地档做退化检测：解析 SSE 增量，累积纯文本
                if mode == "local":
                    linebuf += chunk.decode("utf-8", "ignore")
                    while "\n" in linebuf:
                        line, linebuf = linebuf.split("\n", 1)
                        line = line.strip()
                        if not line.startswith("data:"):
                            continue
                        s = line[5:].strip()
                        if not s or s == "[DONE]":
                            continue
                        try:
                            obj = json.loads(s)
                        except Exception:
                            continue
                        d = (obj.get("choices") or [{}])[0].get("delta") or {}
                        if d.get("content"):
                            text_buf.append(d["content"])
                        if d.get("reasoning") or d.get("thinking"):
                            text_buf.append(d.get("reasoning") or d.get("thinking"))
                    joined = "".join(text_buf)
                    if is_degenerated(joined):
                        log("[local] 检测到重复退化，已中断输出（累计 %d 字符）" % len(joined))
                        degenerated = True
                        break

            if degenerated:
                # 补一个结束事件，让客户端正常收尾而不是挂住
                try:
                    tail = b'data: [DONE]\n\n'
                    self.wfile.write(b"%X\r\n" % len(tail))
                    self.wfile.write(tail)
                    self.wfile.write(b"\r\n")
                    self.wfile.flush()
                except Exception:
                    pass
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except Exception as e:
            log("[%s] 流式传输中断: %s" % (mode, e))
        finally:
            try:
                conn.close()
            except Exception:
                pass
        return True

    def _send_error(self, code, msg):
        body = json.dumps({"error": {"message": msg, "type": "failover_proxy"}},
                          ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception:
            pass


def main():
    log("=" * 60)
    log("LLM Failover Proxy 启动")
    log("  监听      : http://127.0.0.1:%d" % LISTEN_PORT)
    log("  云端上游  : %s" % UPSTREAM)
    log("  本地回退  : %s  (%s)" % (LOCAL, LOCAL_MODEL))
    log("  探测间隔  : %d 秒" % PROBE_INTERVAL)
    log("  初始状态  : %s" % get_mode())
    log("=" * 60)

    t = threading.Thread(target=watchdog, daemon=True)
    t.start()

    srv = ThreadingHTTPServer(("127.0.0.1", LISTEN_PORT), Handler)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("收到中断，退出")
        srv.shutdown()


if __name__ == "__main__":
    main()
