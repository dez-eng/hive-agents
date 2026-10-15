# hive v2 设计 —— A 主 + B/C/D 副

> 一句话：**v2 不引入第二份 prompt。** 全系统仍只有一段 `STABLE_PREFIX` + 一套工具 schema，
> agent 之间的差别只体现在两处 —— **栈顶那句模块片**（尾部、边际成本≈0）和**执行层权限**。
> 这是 v0.1 三条设计约束的直接外推，不是新增架构。
>
> §10 的三个待拍板项已于 2026-10-15 定稿，决策已并入正文对应章节（§4 / §5 / §9）。

## 0. 不改的三条（改任何一条前先看 `/cost`）

1. `STABLE_PREFIX` 逐字节不变（唯一例外见 §7 的「一次性前缀税」）
2. 角色片挂在用户消息末尾 —— 换模块/换 agent 只动尾部
3. 权限收在执行层：指令层给全套工具，`call_tools` / `delegate` 入口按当前身份挡

## 1. 身份模型

| agent | 角色 | 工作记忆 | 模块（现有 `owner`） |
|---|---|---|---|
| A | 主控：持有会话、精简、再分配 | **独占** checkout 主 thread | `assistant` `calc` |
| B | 侦察/渗透 | 无状态，按任务切片 | `recon` |
| C | 修复 | 无状态，按任务切片 | `fix`（新增） |
| D | 审计复核 | 无状态，按任务切片 | `audit` |

- **A 的记忆 = 当前会话 thread**（沿用 v0.1 行为，`/new` 仍是冷缓存）
- **B/C/D 的记忆 = 一次性 thread**：`${thread}#C#${taskId}`，跑完即弃，绝不继承 A 的历史
  → 「无状态」不是嘴上说的，是 checkpoint 物理隔离

## 2. 模块栈（栈式恢复，不是覆盖）

`session.ts`：`moduleId: string` → `stack: string[]`（栈底 = A 的模块，栈顶 = 当前执行者）

- `/use <id>` 压栈；`/pop` 弹栈；`/stack` 查看
- 借调 C 结束 → 自动弹回 B；B 结束 → 弹回 A。**这就是需求里的「栈式恢复」**
- footer 加一段：`栈 A›B`（宽度不够最先丢它）

## 3. 副 agent 运行时

新文件 `src/core/subagent.ts`：

```ts
runSubagent(o: { as: AgentId; input: HandoffInput; budgetTokens: number; token: Token }):
  Promise<HandoffResult>
```

- 独立 thread、独立 `TokenMeter`、独立账本行（`agent='C'`、`tag='sub'`）
- 只拿到 `input.slice`（结构化切片），拿不到 A 的 messages

## 4. 授权令牌（执行层的钥匙，不是提示词）

```ts
Token = { id, issuedBy: 'A', to: 'B', mayCall: ['C','D'], budgetTokens, expiresAt, spent }
```

- **B 想借调 C/D：必须持有 A 签发的令牌**。`delegate` 执行层按序校验：
  有令牌 → 未过期 → 目标 ∈ `mayCall` → 子预算 ≤ 余额（否则直接返回 `ERROR: 未授权/超预算`，不进模型）
- `/grant C,D 5000` 由用户在 A 身份下签发 → 落 `tokens` 表
- 这条与 v0.1 的模块白名单同构：**拦在执行层，模型看不到也绕不过**

**签发方式（2026-10-15 定）：默认自动签发。** A 判断任务需要借调 C/D 时自行签发令牌，
日常使用无感；`/grant` 保留为手动签发 / 收紧授权（例如把某类目标从 `mayCall` 里摘掉）的手段。
> 意味着「借调」这件事默认由 A 自行决定 —— 想改回人工闸门时，把自动签发那一步关掉即可，
> 令牌机制本身不用动。

## 5. 交接 schema（不传原文）

```ts
HandoffInput  = { taskId, from, to, goal, slice, expect, budgetTokens }
HandoffResult = { taskId, ok, output?, tokens, costUsd, notes, budgetHit }
```

- `slice` 是结构化文本切片（文件路径 + 行号 + 片段），**不是**对话原文
- 落 `handoffs` 表（与 `costs.db` 同库）→ `/handoffs` 可回放「谁把什么交给了谁、花了多少」

**痕迹策略（2026-10-15 定）：子 thread 的 checkpoint 跑完即弃，`handoffs` 表留。**
- 弃 checkpoint → `.hive/memory.db` 不随子任务数量膨胀
- 留 `handoffs` → 「那个子任务花了多少」事后仍查得到（与 `/turn` 的成本可见性诉求一致）
- 子任务的逐轮 token **仍逐行计入 `ledger`**（只是 checkpoint 不存）—— 成本不因弃上下文而丢

## 6. 预算闸门

`callModel` 前检查 `meter.costUsd > budget` → 抛 `BudgetExceeded` → 返回结构化失败（`budgetHit: true`），
账本如实记录被熔断。**闸门在模型调用之前，不在输出之后**（输出后才拦 = 钱已经花了）。

## 7. 账本扩列（向后兼容）

`ALTER TABLE ledger ADD COLUMN`：`agent` / `task_id` / `budget_tok` / `budget_hit`
（v0.1 已补过 `module`，同一套路；6.7 的旧行保持可读）

⚠ **一次性前缀税**：新增 `delegate` 工具进 `ALL_TOOLS` 会改工具 schema = 前缀变一次 = 全盘缓存作废一次。
所以**工具要一次加齐**，别边做边加。这是 v2 唯一一次可接受的缓存作废。

## 8. 命令面

| 命令 | 作用 |
|---|---|
| `/stack` · `/pop` | 看栈 / 弹栈（栈式恢复的手动版） |
| `/as A\|B\|C\|D` | 手工切身份（调试/演示用，等价于压栈） |
| `/delegate <to> <goal>` | 让当前 agent 把任务交出去（走令牌+预算） |
| `/grant C,D 5000` | A 签发令牌（默认自动签发之外的收紧手段） |
| `/handoffs [n]` | 交接记录 |
| `/budget` | 本会话预算余额 |
| `/thinktest` | 探 DeepSeek 思考开关（分级思考预算的前置）—— **M1 交付** |

## 9. 里程碑

- **M1 地基（零 API）**：栈 + 身份 + 令牌/handoff/账本数据结构 + 执行层校验 + 单测
  **+ `/thinktest`（2026-10-15 定，并入 M1）** —— 它悬了很久，是「思考预算按任务分级」的前置，
  且属零 API 可测范围，与地基一起收掉
- **M2 运行时（零 API，假模型可测）**：`runSubagent` + 预算闸门 + `handoffs` 落库 + 命令 + footer 段
- **M3 真机**：A→B→C 借调跑一轮，核账（命中率有没有掉、思考占比多少）；按 `/thinktest` 的结论给模块配思考预算

## 10. 已拍板（2026-10-15）

| # | 议题 | 决定 | 落到哪 |
|---|---|---|---|
| 1 | 授权方式 | **默认自动签发**，`/grant` 作为收紧手段 | §4 |
| 2 | 子任务痕迹 | **checkpoint 弃、`handoffs` 表留**，token 逐行入账本 | §5 |
| 3 | M1 范围 | **顺带把 `/thinktest` 做掉** | §9 |
