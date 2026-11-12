# -*- coding: utf-8 -*-
"""Failover 代理的自动化验证。

运行方式：
    python -m unittest test_proxy -v

覆盖：
  1. /__status 端点结构与模式字段
  2. 云端链路透传（需要 DEEPSEEK_API_KEY，缺失则跳过）
  3. 本地回退链路：model 改写、非空回答、X-LLM-Mode 标记
  4. 云端不可达时自动降级到本地
"""
import json
import os
import socket
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MAIN_BASE = "http://127.0.0.1:11500"
# 与本目录内的 .env 或用户级 ~/.hive/.env 对齐，不写死个人绝对路径
ENV_PATH = os.path.join(HERE, ".env")
if not os.path.exists(ENV_PATH):
    ENV_PATH = os.path.join(os.path.expanduser("~"), ".hive", ".env")
LOCAL_MODEL = "qwen3:30b-a3b-thinking-2507-q4_K_M"


def wait_port(port, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as s:
            s.settimeout(0.5)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return True
        time.sleep(0.3)
    return False


def post_chat(base, model="deepseek-v4-flash", content="hi", max_tokens=2048,
              key="test", timeout=300):
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": max_tokens,
        "stream": False,
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + "/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + key},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, dict(r.headers), json.loads(r.read().decode("utf-8"))


def load_key():
    if not os.path.exists(ENV_PATH):
        return None
    with open(ENV_PATH, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if line.startswith("DEEPSEEK_API_KEY"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


class TestMainProxy(unittest.TestCase):
    """针对常驻代理 11500 的检查。"""

    def test_status_endpoint(self):
        with urllib.request.urlopen(MAIN_BASE + "/__status", timeout=10) as r:
            data = json.loads(r.read().decode("utf-8"))
        self.assertIn(data["mode"], ("cloud", "local"))
        self.assertEqual(data["local_model"], LOCAL_MODEL)
        self.assertIn("switches", data)

    def test_cloud_passthrough(self):
        key = load_key()
        if not key:
            self.skipTest("未找到 DEEPSEEK_API_KEY")
        status, headers, data = post_chat(MAIN_BASE, key=key, max_tokens=256,
                                          content="只回答两个字：正常")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("X-LLM-Mode"), "cloud")
        self.assertNotIn("error", data)
        text = data["choices"][0]["message"]["content"]
        self.assertTrue(text.strip(), "云端回答不应为空")
        self.assertIn("deepseek", str(data.get("model", "")).lower())


class TestLocalFallback(unittest.TestCase):
    """启动临时 local 实例，验证回退链路。"""

    port = 11599
    proc = None

    @classmethod
    def setUpClass(cls):
        env = dict(os.environ)
        env.update({
            "LISTEN_PORT": str(cls.port),
            "FORCE_STATE": "local",
            "PROBE_INTERVAL": "9999",
        })
        cls.proc = subprocess.Popen(
            [sys.executable, "failover_proxy.py"],
            cwd=HERE, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if not wait_port(cls.port):
            cls.proc.terminate()
            raise RuntimeError("临时代理未能启动")

    @classmethod
    def tearDownClass(cls):
        if cls.proc and cls.proc.poll() is None:
            cls.proc.terminate()
            try:
                cls.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.proc.kill()

    def test_status_is_local(self):
        with urllib.request.urlopen("http://127.0.0.1:%d/__status" % self.port,
                                    timeout=10) as r:
            data = json.loads(r.read().decode("utf-8"))
        self.assertEqual(data["mode"], "local")

    def test_model_rewrite_and_nonempty_answer(self):
        # max_tokens 故意给小值，验证代理会自动抬高预算
        status, headers, data = post_chat(
            "http://127.0.0.1:%d" % self.port,
            content="用一句话说明：什么是 SQL 注入？",
            max_tokens=64,
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("X-LLM-Mode"), "local-fallback")
        self.assertEqual(data.get("model"), LOCAL_MODEL)
        msg = data["choices"][0]["message"]
        content = (msg.get("content") or "").strip()
        thinking = (msg.get("thinking") or "").strip()
        # 答案不能为空；若被思维链挤空，代理应已回填
        self.assertTrue(content or thinking, "本地回答与思维链不能同时为空")
        self.assertTrue(content, "最终答案不应为空（代理应已抬高 max_tokens）")


class TestAutoDegrade(unittest.TestCase):
    """上游不可达时，应自动降级到本地。"""

    port = 11598
    proc = None

    @classmethod
    def setUpClass(cls):
        env = dict(os.environ)
        env.update({
            "LISTEN_PORT": str(cls.port),
            "UPSTREAM_URL": "http://127.0.0.1:19999",  # 不存在的端口
            "PROBE_INTERVAL": "9999",
        })
        cls.proc = subprocess.Popen(
            [sys.executable, "failover_proxy.py"],
            cwd=HERE, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if not wait_port(cls.port):
            cls.proc.terminate()
            raise RuntimeError("临时代理未能启动")

    @classmethod
    def tearDownClass(cls):
        if cls.proc and cls.proc.poll() is None:
            cls.proc.terminate()
            try:
                cls.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.proc.kill()

    def test_auto_degrade(self):
        base = "http://127.0.0.1:%d" % self.port
        with urllib.request.urlopen(base + "/__status", timeout=10) as r:
            before = json.loads(r.read().decode("utf-8"))
        self.assertEqual(before["mode"], "cloud", "初始应为 cloud")

        status, headers, data = post_chat(base, content="hi", max_tokens=64)
        self.assertEqual(status, 200, "降级后也应返回 200")
        self.assertEqual(headers.get("X-LLM-Mode"), "local-fallback")
        self.assertTrue(data["choices"][0]["message"].get("content", "").strip())

        with urllib.request.urlopen(base + "/__status", timeout=10) as r:
            after = json.loads(r.read().decode("utf-8"))
        self.assertEqual(after["mode"], "local")
        self.assertGreaterEqual(after["switches"], 1)


class TestAgentTier(unittest.TestCase):
    """带 tools 的请求应走 hybrid 模型并关闭思考。"""

    port = 11597
    proc = None

    @classmethod
    def setUpClass(cls):
        env = dict(os.environ)
        env.update({
            "LISTEN_PORT": str(cls.port),
            "FORCE_STATE": "local",
            "PROBE_INTERVAL": "9999",
        })
        cls.proc = subprocess.Popen(
            [sys.executable, "failover_proxy.py"],
            cwd=HERE, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if not wait_port(cls.port):
            cls.proc.terminate()
            raise RuntimeError("临时代理未能启动")

    @classmethod
    def tearDownClass(cls):
        if cls.proc and cls.proc.poll() is None:
            cls.proc.terminate()
            try:
                cls.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.proc.kill()

    def _post_with_tools(self):
        tools = [{
            "type": "function",
            "function": {
                "name": "complete_step",
                "description": "标记计划中的一个步骤已完成。",
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
        payload = {
            "model": "deepseek-v4-flash",
            "messages": [
                {"role": "user", "content": "用 complete_step 标记 plan_step_01 已完成，result 写“测试通过”。"}
            ],
            "tools": tools,
            "max_tokens": 512,
            "stream": False,
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            "http://127.0.0.1:%d/v1/chat/completions" % self.port,
            data=body,
            headers={"Content-Type": "application/json", "Authorization": "Bearer x"},
        )
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=300) as r:
            data = json.loads(r.read().decode("utf-8"))
        return data, time.time() - t0

    def test_agent_tier_uses_coder_model(self):
        data, dt = self._post_with_tools()
        self.assertEqual(data.get("model"), "qwen3-coder:30b",
                         "带 tools 的请求应路由到代码模型")
        msg = data["choices"][0]["message"]
        reasoning = (msg.get("reasoning") or msg.get("thinking") or "").strip()
        # 代码模型本身无 thinking 能力，不应有思维链
        self.assertLess(len(reasoning), 200,
                        "agent 档不应有思维链，实际 %d 字符" % len(reasoning))
        calls = msg.get("tool_calls") or []
        self.assertTrue(calls, "应产生工具调用")
        args = calls[0]["function"]["arguments"]
        if isinstance(args, str):
            args = json.loads(args)
        self.assertEqual(args.get("step_id"), "plan_step_01")
        self.assertIn("result", args)
        # 关思考后应当明显更快
        self.assertLess(dt, 120, "agent 档耗时 %.1fs 过长" % dt)


class TestDegenerationDetection(unittest.TestCase):
    """退化检测：能识别重复循环，且不误伤正常文本。"""

    def setUp(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "fp", os.path.join(HERE, "failover_proxy.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.fn = mod.is_degenerated

    def test_normal_text_not_flagged(self):
        normal = "".join("第%d步：执行命令并检查返回值是否正确。" % i for i in range(30))
        self.assertFalse(self.fn(normal))

    def test_repeated_block_flagged(self):
        block = "\\boxed{\n{\"function\":\"todos_write\",\"arguments\":{\"todos\":[]}}}\n</answer>\n" * 6
        self.assertTrue(self.fn(block), "连续重复的格式标签应被判定为退化")

    def test_short_repeat_not_flagged(self):
        # 短文本即便重复也不该误杀（长度不足阈值）
        self.assertFalse(self.fn("ok ok ok"))

    def test_whitespace_only_not_flagged(self):
        self.assertFalse(self.fn(" " * 1000))


if __name__ == "__main__":
    unittest.main(verbosity=2)
