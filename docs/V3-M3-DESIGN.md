# hive v3 · M3 设计 —— 子会话可续 + 按 agent 核账

> 一句话：M2 的借调是「交办一次、拿回一个终值」；M3 把它升级成**能接着问的会话**，
> 并把「每个 agent 各自花了多少、缓存命中如何」从账本里汇总出来。
>
> 范围按 V3-PLAN §5 的建议收窄：**先只做可续（父驱动往返）**。
> 并行借调、B 主动反问 A（回调通道）留到 M3.5，不在本文实现。

## 0. 现状（代码事实）

1. `runSubagent` 每次用 `subThread(main, as, taskId)` 造一个独立 thread，
   跑完只留 `handoffs` 一行；**thread 本身没有落库**，事后无从找回。
2. `delegate` 工具的参数只有 `to / goal / slice / expect / budgetTokens` ——
   一次交办一个目标，父想追问只能换一个新 `taskId`，子 agent 看不到上一轮。
3. 账本 `ledger` 表已有 `agent` 列（v2 起），但只有逐行视图；
   没有「A/B/C/D 各自命中率与成本」的聚合入口。
4. `handoffs` 表按 `task_id` 汇总（`handoffTotals`），天然支持「同一任务多轮」。

## 1. 可续子会话

### 1.1 一句话模型

```
第一次：父 ──delegate(goal/slice/expect)──▶ 子 thread main#C#t001-aaaa
续跑：  父 ──delegate(resume=t001-aaaa, goal=追问)──▶ 同一个 thread
```

- **thread 不变** → 子 agent 读得到自己上一轮的历史（checkpoint 已在 `memory.db`）。
- **仍然是父驱动**：子 agent 不能主动打断父会话；它只是在同一会话里接下一句。
- **每次续跑仍过同一道闸**：身份白名单 → 令牌归属 → 令牌预算 → 子预算。

### 1.2 thread 落库

`handoffs` 表补一列 `thread TEXT NOT NULL DEFAULT ''`（老库 `ALTER TABLE`，O(1)）。
`HandoffRecord` 同步加 `thread?: string`。

- 新记录写入完整子 thread（`main#C#t001-aaaa`）。
- `Ledger.findHandoff(taskId)` 取最近一条；续跑靠它拿 `thread / from / to`。
- M3 之前的老记录没有 thread —— 明确报「这条交接没有 thread，无法续跑」，
  不猜、不从 `taskId` 反推（主 thread 可能不是 `main`）。

### 1.3 归属与授权

| 检查 | 规则 |
|---|---|
| 会话归属 | 只有原发起方（`handoff.from`）能续；A 也不能接管别人发起的子会话 |
| 目标身份 | 续跑目标必须等于原 `to`（不允许「续着续着换人」） |
| 令牌 | 仍走 `authorizeDelegate`：副 agent 必须有 A 签给本人的有效令牌 |
| 预算 | 续跑单独给 `budgetTokens`，从同一张令牌余额里扣 |

> 归属检查放在授权之前，理由与 M2 相同：**挡在花模型钱之前**。
> 失败返回结构化原因，不写 handoffs（没发生的事不留痕）。

### 1.4 接口

```ts
// subagent.ts
export interface ContinueSubagentOptions {
  as: AgentId;        // 子会话身份（= 原 to）
  from: AgentId;      // 这次是谁在续
  owner: AgentId;     // 原子任务的发起方（handoff.from）
  token: Token | null;
  thread: string;     // 原样复用，不重新派生
  taskId: string;     // 复用，账本按它汇总多轮
  text: string;       // 追加给子 agent 的一句话
  budgetTokens: number;
  deps: RunSubagentDeps;
  onChunk?: (piece: string) => void;
}
export function continueSubagent(o: ContinueSubagentOptions): Promise<HandoffResult>;
```

- `runSubagent` 与 `continueSubagent` 共用内部的 `execute()`：
  授权、跑一轮、记账、扣令牌、落 handoffs 完全同一条路，只有
  「thread 怎么来」和「输入文本怎么来」不同。
- `HandoffResult` 加 `thread?: string`：第一次交办就把 thread 告诉上层，
  父可以直接拿它续（不必再查库）。`HandoffResultSchema` 同步加可选字段。
- 续跑的 handoffs 行：同一 `task_id`、`goal = [续跑] <追加文本>`、
  `expect = 续跑`、`slice` 不进库（表里本来也只存 goal/expect 摘要）。

### 1.5 工具层

`delegate` 的参数加一个可选项：

```jsonc
{
  "to": "C",
  "goal": "把那处比较改成 startsWith",
  "slice": "…",              // 首跑必填；续跑可省
  "expect": "…",             // 首跑必填；续跑可省
  "budgetTokens": 2000,
  "resume": "t001-aaaa"      // 可选：续跑哪个子会话
}
```

- `slice` / `expect` 改为可选；`resume` 不存在时仍按原有规则校验（缺了就报错）。
- `resume` 存在时：`goal` 就是追问内容，`to` 若给了必须与原目标一致（不给则用原目标）。
- **缓存代价**：这是在工具 schema 里加字段 —— 会作废装了 `delegate` 的
  agent（A/B）的前缀缓存一次。这是 M3 的功能成本，`/caps` 能看到字符数变化。

REPL 侧加显式入口，便于人/脚本续跑：

```
/delegate --continue <taskId> <追加内容>
```

## 2. 按 agent 核账

`Ledger.byAgent(scope?)`：

```sql
SELECT agent, SUM(calls), SUM(in_tok), SUM(cache_hit), SUM(out_tok),
       SUM(reason_tok), SUM(cost_usd), COUNT(*)
FROM ledger WHERE tag='turn' [AND day=?] [AND run_id=?] [AND thread_id=?]
GROUP BY agent ORDER BY agent
```

- 只统计 `tag='turn'`（policy 行不是消费，M2 已定）。
- `agent=''` 的老行归到「未标记」，不丢弃 —— 历史账照样能看。
- `/ledger agents` 展示：轮数、调用、入/命中率、出（思考）、成本、均成本/轮。
- 不做「按 agent 的预算」：预算仍是令牌维度，别在 M3 里混两套口径。

## 3. 不做的（留给 M3.5 / 以后）

- **并行借调**（父同时派 B 和 D）：需要并发 run + 共享图 runtime 的隔离，单开一批。
- **B 主动反问 A**：需要回调通道 / 事件流，不是「可续」的推论。
- **`@B` 寻址、广播**：V3-PLAN §7 已定不上总线。
- **独立会话的跨进程续跑**：`solo#B` 已可续（checkpoint 在 `memory.db`），本批不动。
- **沙箱档位预设**：policy 已是可配置的，M3 不引入第二套「档位」概念。

## 4. 影响面

- prompt 的 `STABLE_PREFIX` 不动；只有 `delegate` 的 schema 变长（A/B 缓存作废一次）。
- `handoffs` 加列，老库可读；`HandoffResult` 加可选字段，旧调用方不受影响。
- `/delegate` 旧语法不变；`--continue` 是新分支。
- 所有新增路径都能零 API 测试（假 runner / 临时 SQLite）。

## 5. 测试计划（零 API）

| 用例 | 断言 |
|---|---|
| 首跑返回 thread | `HandoffResult.thread === 'main#C#t001-aaaa'`，handoffs 落库 |
| 续跑复用 thread | 第二次 `runner.seen[0].threadId` 与第一次相同 |
| 续跑追加文本 | 发送的是追问原文（含角色片），不是重新渲染的 slice |
| 归属：别人不能续 | B 续 A 发起的 → 拒，runner 不跑 |
| 归属：C 不能续 B 发起的 | 拒 |
| 授权：无令牌 / 过期 | 续跑同样被拒 |
| 同 taskId 多行 handoffs | `handoffTotals` 汇总两轮 |
| `findHandoff` | 取到最近的 thread/from/to；老记录 thread 为空时明确报错 |
| 老库补列 | 无 thread 列的 handoffs 打开后能补列并照读 |
| `byAgent` | 两个 agent 的轮次分别汇总；policy 行不混入 |
| `delegate(resume)` 执行层 | 模型带 resume 调工具 → 同一子 thread、新 handoff、扣令牌 |
