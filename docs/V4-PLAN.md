# hive v4 · 产品化路线图

> 目标：从「能跑通的多 agent CLI」变成「**正常可工作、可扩展、可协调**的产品级 agent」。
>
> 本文只定差距、顺序与验收标准；§4 的四个待拍板项定了再动代码。

## 0. 现在的成熟度（2026-10-19 事实）

- `npm test`：**177 个测试全绿**（全部零 API）
- M3.1 真机验收通过：A→C 首跑写入、`/delegate --continue` 续同一子会话改写、
  `/handoffs` 两行同 taskId、`/ledger agents` 按身份汇总。成本约 **$0.0006**
- 已具备：缓存友好前缀、按身份装配的 8 个工具、能力网关（L1）、
  可续子会话、按 agent 核账、独立会话、账本、策略配置
- 一句话定位：**最会算账、最守边界、最适合多角色长时间协作的本地 agent**

## 1. 四条线的差距

### 1.1 可工作 —— 能不能稳定当工具用

| 现状 | 产品级要求 | 差距 |
|---|---|---|
| `SIGINT` 直接退出整个进程（`repl.ts:208`） | Ctrl+C 停当前轮，再按一次退出 | 长任务按 Ctrl+C 会丢会话；无 `AbortController` |
| 模型错误只靠 `maxRetries: 2` | 可见的重试 / 降级 / 明确错误分类 | 429、超时、网络、鉴权混成一句 `调用失败` |
| 配置只有 `.env` + `.hive/policy.json` | `hive init` 生成配置；启动时校验并给可执行的修复建议 | 新用户要读 README 才知道放 `.env`；配置写坏只有 deny |
| Windows 实测；Linux/macOS 未测 | CI 三平台跑 `typecheck` + `test` | 无 `.github/workflows` |
| 单进程假设 SQLite | 多实例并发时锁冲突可预期、可恢复 | 无 busy_timeout / 重试 |
| npm 发布卡 OTP | `npm i -g hive-agents` 一条命令 | 只差 6 位 OTP |

### 1.2 可扩展 —— 加能力要不要改源码

| 现状 | 产品级要求 | 差距 |
|---|---|---|
| capability 硬编码在 `capability.ts` 的注册表 | 第三方 capability 可注册，不改核心 | 无插件边界、无版本、无生命周期 |
| `web` / `skill` 只声明未实现 | `fetch`（域名白名单）与 playbook 装载 | 0 个工具 |
| 无 MCP | 能接任意 MCP server，工具按 server 动态装配 | 无 client、无工具命名空间 |
| provider 写死 `ChatDeepSeek`（`agent.ts:155`） | 一个 OpenAI-compatible 适配层覆盖 DeepSeek/OpenAI/Ollama | `buildModel` 与 `PRICE` 都绑死 DeepSeek |
| agent / 模块定义写死在 `modules.ts` | 从配置读 agent 定义（能力、主模块、mayCall） | 加一个身份要改源码 |
| 无 skill | 装载 playbook（把一段方法论文本临时挂到尾部） | 与"前缀不变"约束的交互未设计 |

### 1.3 可协调 —— 多个 agent 能不能真协作

| 现状 | 产品级要求 | 差距 |
|---|---|---|
| 图 runtime 是**单个闭包变量**（`agent.ts:433`），一次只有一个活跃 run | 多个子任务可并发跑，各自计量、各自预算 | 必须改成每 run 独立 runtime（见 §3.1） |
| `delegate` 串行：A 派完 B 才能派 D | A 可同时派 B 和 D，再汇总 | 无并发调度、无结果合并 |
| 子会话只能父驱动 | B 可主动反问 A / 请求补充信息 | 无回调通道（M3.5 遗留） |
| taskId 只落账本，模型看不到 | 首跑结果里带 taskId，模型能自己续 | `formatDelegateResult` 没输出 taskId |
| 无任务列表 / 取消 / 超时 | `/tasks` 看运行中与已完成；可取消 | 无任务生命周期 |
| `@B` 寻址 / 广播 | **不做**（V3-PLAN §7 已拍板不上总线） | — |

### 1.4 产品级工程

| 现状 | 产品级要求 |
|---|---|
| 无 CI | GitHub Actions：三平台 + typecheck + test + build |
| 无 CHANGELOG / CONTRIBUTING | 变更可追溯，外部可贡献 |
| 无结构化日志 | `HIVE_DEBUG=1` 输出调试事件；错误带 runId/taskId |
| 安全 L1 | 产品化清单上标 L3（容器），不假装现在就有 |
| 版本 0.1.0，发布未完成 | 发布节奏与语义化版本策略 |

## 2. 里程碑（建议顺序）

### M4.1 协调：并行借调 + 任务生命周期（2026-10-19 完成）

**为什么先做**：这是"可协调"的核心缺口，也是定位里"多角色协作"的下一个真实瓶颈；
不改 runtime 模型，后面的 MCP / 多 provider 都会踩同一个坑。

真机验收（2026-10-19）：A 用 `parallel` 同时派 C（写文件）和 D（读 README），
两个子任务耗时 1927ms / 1947ms 完全重叠；`/tasks` 两条完成、`/handoffs` 两个独立
taskId；总花费约 $0.0007。零 API 测试另加 9 项（并发 4 + 任务表 5），全量 186 绿。

改动点：

1. **每 run 独立 runtime**（§3.1）：`runtime` 从闭包变量改为按 run 传递
   （`AsyncLocalStorage` 或 LangGraph `configurable`），彻底去掉"一次只有一个活跃 run"的假设。
2. `delegate` 支持 `parallel: [{to, goal, slice, expect, budgetTokens}, …]`：
   `Promise.allSettled` 并发跑，逐个落 handoffs，汇总成一条结构化结果。
3. 首跑结果带上 `taskId`（例如 `[C·t50278-e8c2 2275 token] …`），模型可直接续。
4. `/tasks`：本轮发起的子任务、状态（运行中/完成/熔断/拒绝）、token、成本。
5. 超时与取消：每个子任务可带 `timeoutMs`；取消走 `AbortController`。

零 API 测试：并发两个假 runner → 各自 meter 不串、账本两行、预算各扣各的；
并行中一个失败不影响另一个；`/tasks` 汇总正确。

### M4.2 扩展：provider 抽象 + MCP + skill

1. **provider 适配层**：`ChatOpenAI`-compatible（DeepSeek/OpenAI/Ollama 一套），
   `PRICE` 按 provider+model 查表；`hive doctor` 报当前 provider 与价格来源。
2. **MCP client**：配置文件里列 server（stdio / http），启动时拉工具清单，
   按 `mcp:<server>:<tool>` 命名装配成 capability；网关的 `kind` 映射到 `net`/`exec`。
3. **skill**：`skill` capability 装载 playbook 文件；文本挂在**用户消息末尾**（不动前缀），
   与角色片同一位置。
4. **web**：`fetch`，域名白名单走 policy 的 `net`；默认 deny。
5. **配置化 agent**：`hive.config.json` 可覆盖 `AGENTS`（capabilities / home / mayCall），
   缺省仍用内置表。

### M4.3 可工作：中断、恢复、初始化

1. Ctrl+C 只中止当前轮（`AbortController` 传进 `HiveAgent.run`），再按一次退出。
2. 错误分类：鉴权 / 限流 / 网络 / 预算 / 策略，各自给人话与下一步。
3. `hive init`：生成 `.env.example`、`.hive/policy.json`、`hive.config.json`，并跑一次 `doctor`。
4. SQLite `busy_timeout` + 写重试；多实例并发不崩。
5. `HIVE_DEBUG=1` 的结构化调试日志（默认关，零成本）。

### M4.4 发布：CI、文档、npm

1. GitHub Actions：Windows/Linux/macOS × Node 22/24，跑 `typecheck` + `test` + `build`。
2. CHANGELOG（Keep a Changelog）、CONTRIBUTING。
3. npm 发布：按 §4 第 4 项拍板的版本，附 GitHub Release 与 tgz。
4. 发布后跑一次「干净机器」安装验收：`npm i -g` → `hive init` → `hive doctor` → 真机一轮。

## 3. 关键设计点

### 3.1 并行借调的执行模型（M4.1 地基）

现状：`buildGraph` 里 `let runtime` 是整张图共享的一个闭包变量；`run()` 用
「保存-设置-恢复」保证嵌套时各读各的。这套在**串行**下成立，并发下必然串账。

三个候选：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. AsyncLocalStorage（推荐）** | 每次 `run()` 建 runtime，放进 ALS；节点从 ALS 取 | 改动集中，Node 原生；需确认 LangGraph 的异步链不丢上下文 |
| B. 每个 run 一个 `HiveAgent` 实例 | 并发时 new 多个实例 | 每个实例一套 SQLite checkpointer，连接数上升 |
| C. 串行队列 | 并行请求排队执行 | 实现最省事，但不是真并行，不满足目标 |

推荐 A；若 ALS 在 LangGraph 的 stream 里丢上下文，再退到 B。

### 3.2 MCP 与缓存约束的冲突

MCP 工具是**动态清单**：server 一换，工具 schema 就变，前缀缓存作废。
处理原则：启动时**一次性**拉清单并冻结，运行中不热插拔；清单变化通过显式
`/mcp reload` 触发，并在 UI 明说「这次会作废哪些 agent 的缓存」。

### 3.3 skill 挂哪里

必须挂在**用户消息末尾**（与角色片同位置），不能进 system 前缀 —— 否则每次装载
skill 都是一次全盘缓存作废。skill 文本按需装载，不进 checkpoint。

## 4. 已拍板（2026-10-19）

| # | 议题 | 决定 |
|---|---|---|
| 1 | M4.1 并行执行模型 | **A. `AsyncLocalStorage`** —— 每 run 独立 runtime，父子 run 靠异步链隔离 |
| 2 | 扩展机制优先级 | **A. MCP 优先** —— 接任意 MCP server，工具动态装配；自研插件留后 |
| 3 | provider 范围 | **B. 只做 DeepSeek 配置化** —— 模型名、价格、配置可改，暂不引入多 provider 适配层 |
| 4 | 发布节奏 | **A. 先发 0.1.0** —— 先跑通 npm 发布链路，功能进后续版本 |

## 5. 不做什么

- 不上总线 / 广播 / `@` 寻址（V3-PLAN §7 已拍板）
- 不引入固定沙箱档位（policy 已可配置）
- 不为了工具数量牺牲前缀缓存；每个新能力都要先回答「它进不进前缀、作废谁」
- 不在 M4 做容器级隔离（L3 是产品化清单，不是本批）

## 6. 产品级验收标准

1. 干净机器：`npm i -g hive-agents` → `hive init` → `hive doctor` → 真机一轮，全程不需要手写 `.env`
2. CI 在 Windows/Linux/macOS 全绿（typecheck + 177+ 测试 + build）
3. 并行借调：零 API 并发测试 + 一次真机（两个子任务同时跑，账本各自独立）
4. 至少一个真实 MCP server 能接上并调用
5. Ctrl+C 能停当前轮且会话不丢
6. `0.x` 发布到 npm，GitHub Release 附 tgz
