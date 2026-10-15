# hive

一个把「省 token」当第一性问题的 agent CLI：**一段逐字节不变的前缀 + 挂在消息末尾的角色模块 + 内置的 token 账本**。

基于 langgraph.js（TypeScript / Node），`npm i -g` 后一条 `hive` 就能开。

> 它不是又一个聊天壳子。它是从一批实测里长出来的：阶段 6.7 用 41 组样本量出了
> **未命中 = (入 mod 64) + 64k** 这条几何律，又量出账单的形状 —
> 可见输出只占总花费 3%，思考占 32%，未命中输入占 40%。
> 结论很反直觉：**削「话长」动的是那 3%。**

---

## 三条设计约束

这三条不是审美，是钱的形状决定的。改任何一条之前先看 `/cost`。

### 1. system 前缀逐字节不变

前缀一变，后面整段历史全部作废，等于每轮重付全价。所以：

- 系统提示写成 `STABLE_PREFIX` 常量（`src/core/prompt.ts`），改一个字符就要付一次「全盘作废税」
- 提示不进对话历史，每轮临时拼在最前面 —— 否则它会随历史累积，越聊越贵

### 2. 角色挂在用户消息末尾，不挂在 system

切模块（`/use recon`）= 只换用户消息尾部那几十个 token。因为最末尾那段本来就在
「必然未命中」的尾巴里，边际成本 ≈ 0。实测过：**挂在开头压不住，挂在尾巴上一句就压住了。**

反过来做 —— 每个角色一份完整 system prompt —— 换一次角色就是整段历史缓存作废。

### 3. 权限收在执行层，不在提示词

所有模块共享**同一套工具定义**（工具 schema 在 prompt 开头，属于前缀的一部分，
按模块换工具 = 换前缀 = 缓存全废）。所以：

- 指令层给全套工具
- 执行层按当前模块的白名单挡（`call_tools` 里）

这条也是 v2 多 agent 的地基：**权限不该靠提示词，该靠执行层。**

---

## 多 agent（v2）：A 主 + B/C/D 副

v2 不引入第二份 prompt。全系统仍只有一段 `STABLE_PREFIX` + 一套工具 schema，
agent 之间的差别只体现在两处 —— **栈顶那句模块片**（尾部、边际成本≈0）和**执行层权限**。

| 身份 | 角色 | 主模块 | 可借调 |
|---|---|---|---|
| A | 主控：持会话、精简、再分配 | `assistant` | B / C / D |
| B | 侦察：只陈列事实 | `recon` | C / D |
| C | 修复：按目标改文件 | `fix` | — |
| D | 审计：复核结论与事实 | `audit` | — |

- **无状态副 agent**：B/C/D 的记忆是 `thread#身份#taskId` 的一次性 checkpoint，跑完即弃 ——
  拿不到 A 的历史，是物理隔离，不是提示词叮嘱
- **结构化交接**：agent 之间只传 `{goal, slice, expect, budget}`，schema 里没有「原文」入口
- **授权令牌**：副 agent 借调要走 A 签发的令牌（`/grant` 手动，或 A 借调时自动签发），
  校验拦在执行层 —— 模型看不到也绕不过
- **预算闸门**：按 token 计，闸门在 `callModel` **之前**；超了就熔断，不进模型
- **模块栈**：`/use` 压栈、`/pop` 弹栈，借调结束回到原角色（栈式恢复，不是覆盖）
- **痕迹**：子任务 checkpoint 弃、`handoffs` 表留，逐轮 token 仍入账本

设计与里程碑见 [`V2-PLAN.md`](./V2-PLAN.md)。

---

## 装上

```bash
# 还没发 npm，先本地装
git clone https://github.com/dez-eng/hive-agents.git && cd hive-agents && npm install && npm run build && npm link

# 或者直接用
npx tsx src/cli.ts
```

配 API key：

```bash
cp .env.example .env   # 填 DEEPSEEK_API_KEY
```

## 用

```
hive                 # 交互会话
hive run "3*7 等于几" # 单轮，适合脚本
hive doctor          # 环境自检（含计量字段校准）
```

会话里：

| 命令 | 作用 |
|---|---|
| `/cost` | 账单：本轮 / 会话 / 今日 / 历史 |
| `/turn` | 本会话逐轮消耗一览 |
| `/turn 3` | 第 3 轮明细 |
| `/turn 2-5` | 第 2~5 轮合计 ← **查某聊天段花了多少** |
| `/find 关键词` | 跨历史搜轮次 |
| `/modules` · `/use <id>` | 列模块 / 切模块（压栈） |
| `/stack` · `/pop` | 看模块栈 / 弹一层（借调结束回到原角色） |
| `/as A\|B\|C\|D` | 切身份（压入该 agent 的主模块） |
| `/delegate <身份> <目标>` | 把任务交给另一个身份（令牌 + 预算闸门 + 独立 thread） |
| `/grant <身份> <预算>` | 签发借调令牌（默认自动签发之外的收紧手段） |
| `/handoffs [n]` | 交接记录：谁把什么交给了谁、花了多少 |
| `/budget` | 本会话令牌与预算余额 |
| `/tail on\|off` | 尾部角色片开关（关掉做 A/B 对照） |
| `/status on\|off` | 底部状态行开关 |
| `/new` | 开新会话（冷缓存） |
| `/history` | 存档点 |
| `/help` | 全部命令 |
| `/anatomy` `/misscheck` `/lenstat` `/ledger` `/thinktest` | 诊断（默认不列在 help 里，`/help all` 看） |

底部常驻一行：

```
hive · deepseek-flash · 谷 · 通用+尾 │ 本轮 $0.000043 思考32% k=2 │ 会话 $0.0012/12轮 均118出 │ 上下文 7.4k 命中92% │ 历史 $0.0056 41行 │ 栈 A›B
```

宽度不够就自动丢右边的段（栈段最先丢），绝不换行。账单细节一律藏在命令里。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | 必填 |
| `DEEPSEEK_MODEL` | `deepseek-flash` | 需能在 `src/core/cost.ts` 的 `PRICE` 里找到 |
| `HIVE_MAX_OUT` | `0` | 输出封顶，0 = 不封顶（**实测封顶只会切断答案，省不了钱**） |
| `HIVE_LEDGER` | `.hive/costs.db` | 账本 |
| `HIVE_MEMORY` | `.hive/memory.db` | langgraph checkpoint |

## 账本

`node:sqlite`（Node 内置，零外部依赖）。表结构与阶段 6.7 的 `costs.db` 对齐，
**能直接读你 Python 版留下的历史账**：

```sql
ledger(ts, day, run_id, thread_id, model, band, tag, module, calls,
       in_tok, cache_hit, out_tok, reason_tok, user_chars,
       user_head, out_head, cost_usd, style_on,
       agent, task_id, budget_tok, budget_hit)
```

v2 又加了两张表：`tokens`（授权令牌）与 `handoffs`（交接记录）。

`/misscheck` 会逐对检查几何律是否仍然成立于你的真实数据上 —— 这是唯一能证明
「前缀缓存真的命中了」的手段，比任何猜测都硬。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test（测试文件自带 tsx loader）
npm run build       # 产物在 dist/
```

## 路线图

v0.1（骨架）与 v2 的 M1/M2 都已落地：

- [x] 缓存友好前缀 + 尾部模块槽位
- [x] 执行层权限（模块白名单）
- [x] token 账本 + 几何律检验
- [x] 底部状态行 / 命令面板
- [x] 主 agent A 独占工作记忆，副 agent 无状态、只拿任务切片
- [x] 结构化交接（schema 化的 handoff，不传原文）
- [x] 授权通道：B 借调 C/D 需先取得 A 签发的令牌 → 子任务带预算闸门
- [x] 模块栈：借调结束后回到原角色（栈式恢复，不是覆盖）
- [x] 工具一次加齐（`write_file` / `delegate`，一次性前缀税）
- [x] 思考预算按任务分级（查表类关思考、审计类放开）—— `/thinktest` 实测开关为 `thinking.type=disabled`，映射见 `think.ts` 的 `THINK_KWARGS`

M3（真机）：A→B→C 借调跑一轮，核账 —— 命中率有没有掉、思考占比多少。
`/thinktest` 已跑出结论（`thinking.type=disabled` 把思考打到 0），模块分级已接上。

## License

[MIT](LICENSE) © 2026 dez-eng
