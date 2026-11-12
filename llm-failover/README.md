# LLM Failover Proxy — 断网自动回退本地模型

## 解决什么问题

Reasonix 默认依赖云端 API。断网时（比赛现场网络抖动、代理掉线、云端限流）整个会话直接报错中断。

本代理在中间加了一层，让切换对 Reasonix 完全透明：

```
Reasonix  ──►  http://127.0.0.1:11500  ──►  云端 api.deepseek.com
                    (本代理)          └──►  本地 Ollama qwen3-30b-thinking
```

- 云端正常：原样转发，行为与直连完全一致（实测开销 < 1 秒）
- 云端故障：自动改发本地模型，会话不中断
- 网络恢复：后台探测成功后自动切回云端
- **Reasonix 无需重启**，配置改一次即可

## 触发切换的条件

| 情况 | 是否切换 | 说明 |
|---|---|---|
| 连接失败（断网、DNS 失败） | ✅ 切本地 | 立即判定 |
| 请求超时 | ✅ 切本地 | 连接 10s / 读 180s |
| 上游返回 5xx | ✅ 切本地 | 服务端故障 |
| 上游返回 429 | ✅ 切本地 | 限流 |
| 上游返回 401 / 403 | ❌ 不切 | 是密钥问题，切了也没用，原样报错 |
| 上游返回 400 | ❌ 不切 | 请求本身有问题 |

恢复条件：本地模式下每 30 秒探测云端 `/v1/models`，通即切回。

## 本地模式下的自动适配

### 双档分流（按请求是否带 tools）

| 请求类型 | 使用模型 | 思考 | 原因 |
|---|---|---|---|
| **带 `tools`**（agent / 工具调用） | `qwen3:8b` | **关闭**（`reasoning_effort: none`） | Thinking 模型在 schema 推理上会陷入元认知循环：反复重读 required 字段、自我怀疑，最后输出占位值。工具调用必须干脆。 |
| **不带 `tools`**（问答 / 深度分析） | `qwen3:30b-a3b-thinking-2507` | 保留思维链 | 分析题需要推理深度，思维链有价值。 |

**为什么必须换模型而不只是关思考**：`qwen3:30b-a3b-thinking-2507` 的能力集是 `thinking levels = true`（thinking-only，关不掉）；`qwen3:8b` 是 `thinking levels = false, true`（hybrid，可关）。

**关闭思考的正确方式**：Ollama 的 OpenAI 兼容端点**忽略 `think` 字段**（实测 hybrid 和 thinking-only 都一样），但认 `reasoning_effort: "none"`。原生 `/api/chat` 端点则认 `think: false`。本代理走的是前者。

### 其余适配

1. **model 名改写**：按上表分档改写。
2. **输出预算抬高**：`max_tokens < 6144` 时强制提到 6144。
   原因：Thinking 模型会先消耗大量 token 产出思维链，沿用云端的小预算会导致**返回空内容**。
3. **上下文裁剪**：云端 1M 窗口，本地 16K~40K。超长请求会保留 system + 最近消息，丢弃中间部分并注入降级提示，避免直接报错。
4. **空答案回填**：非流式请求若最终答案为空而思维链有内容，用思维链回填，避免空回复。

## 使用方法

启动（两个服务一起）：
```
D:\langchain\start-all.bat
```

单独启动：
```
D:\langchain\ctf-workspace\start-ollama.bat      代理 Ollama
D:\langchain\llm-failover\start-proxy.bat        启动 failover 代理
```

查看当前状态：
```
curl http://127.0.0.1:11500/__status
```

```json
{
  "mode": "cloud",              // cloud 或 local
  "since": "2026-10-23 19:44:59",
  "reason": "startup",          // 最近一次切换原因
  "switches": 0,                // 累计切换次数
  "upstream": "https://api.deepseek.com",
  "local": "http://127.0.0.1:11434/v1",
  "local_model": "qwen3:30b-a3b-thinking-2507-q4_K_M"
}
```

响应头 `X-LLM-Mode` 会标明本次请求走的是 `cloud` 还是 `local-fallback`。

## 日志

`D:\langchain\llm-failover\failover.log`

关键行：
```
状态切换: cloud -> local (云端请求失败（连接/超时/5xx），自动降级)
[local] 已改写 model=qwen3:30b-a3b-thinking-2507-q4_K_M
状态切换: local -> cloud (云端探测成功，自动恢复)
```

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LISTEN_PORT` | 11500 | 监听端口 |
| `UPSTREAM_URL` | https://api.deepseek.com | 云端基址 |
| `LOCAL_URL` | http://127.0.0.1:11434/v1 | 本地基址 |
| `LOCAL_MODEL` | qwen3:30b-a3b-thinking-2507-q4_K_M | 分析档（无 tools 时使用） |
| `LOCAL_MODEL_AGENT` | qwen3:8b | 工具调用档（带 tools 时使用，关闭思考） |
| `PROBE_INTERVAL` | 30 | 云端探测间隔（秒） |
| `LOCAL_CTX_CHARS` | 45000 | 本地可用上下文字符数（约 16K tokens） |
| `LOCAL_MIN_TOKENS` | 6144 | 本地模式最小输出预算 |
| `CONNECT_TIMEOUT` | 10 | 连接超时（秒） |
| `READ_TIMEOUT` | 180 | 读超时（秒） |
| `FORCE_STATE` | cloud | 测试用，强制初始状态 |

## 回滚（退回直连云端）

```
copy "C:\Users\xyl2\AppData\Roaming\reasonix\config.toml.bak-before-failover-20261023" ^
     "C:\Users\xyl2\AppData\Roaming\reasonix\config.toml"
```

回滚后重启 Reasonix，并把 `D:\langchain\start-all.bat` 从开机启动项移除。

## 故障排查

**代理起不来，Reasonix 全部请求失败**
→ 代理是单点。用 `netstat -ano | findstr 11500` 确认端口在监听；若进程没了，重新跑 `start-proxy.bat`。
→ 应急：按上面「回滚」把 base_url 改回直连。

**切到本地后回答很慢**
→ 正常。30B Thinking 模型单题约 30-90 秒，输出预算 6144 tokens。
→ 想要更快可以另装 Qwen3-4B 并用 `LOCAL_MODEL` 指过去。

**切到本地后报 context length 错误**
→ 提示上下文仍超限。把 `LOCAL_CTX_CHARS` 调小（如 30000），或让代理在本地模式下先精简历史。

**一直停在 local 不切回**
→ 说明探测失败，可能是网络仍不通，或 `PROBE_INTERVAL` 太大。看日志里的探测记录。

## 已知限制

- 代理自身挂掉即全线不可用，属于单点故障。目前没做自动重启（可加 Windows 计划任务或 NSSM 注册服务）。
- 本地模型不支持云端的部分特性（如 `logprobs`、`logit_bias`），已在本地模式主动剔除。
- 流式请求不做空答案回填（回填需要缓冲，会破坏 SSE 实时性）。Thinking 模型流式场景下若 `max_tokens` 给得过小仍可能看到空内容。
