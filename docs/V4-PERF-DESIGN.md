# hive v4 · 性能：把 agent 间往返的墙钟时间压到最低

> 一句话：模型一次给出多个工具调用时，**互不依赖的并发跑**；
> 启动时并排连 MCP；让模型倾向于把独立子任务放进同一批，而不是逐个串行。

## 0. 现状（代码事实）

| 位置 | 现状 | 代价 |
|---|---|---|
| `agent.ts` 的 `callTools` | 同一批 `tool_calls` 用 `for … await` **逐个执行** | 一次模型回复里 3 个 `read_file` / `grep` / `web_fetch`，墙钟 = 三者之和 |
| `mcp.ts` 的 `connectMcp` | `for … await client.connect()` **串行连 server** | 每个 server 一次冷启动（`npx -y` 首次下载更慢），启动时间线性叠加 |
| `delegate` | 默认一次交办一个子任务；`parallel` 要模型显式使用 | A 派 B、再派 D 是两轮串行子任务 |
| `ask_parent`（M3.5） | 暂停-续跑，一次往返 | 信息不足时的必要成本，不是性能问题 |

模型侧的往返（DeepSeek 请求）是主要延迟，**本地能压的是「同一批工具的执行时间」与「启动时间」**。
不碰模型、不改缓存前缀，就不存在为了快而牺牲质量的取舍。

## 1. 批内并行（核心）

`callTools` 改成按**安全边界**分组执行：

```
calls:  [read_file, read_file, grep, write_file, read_file, delegate, delegate]
执行:   └────── Promise.all ──────┘  串行    └── 串行 ──┘  └─ Promise.all ─┘
```

| 工具 | 执行方式 | 理由 |
|---|---|---|
| `read_file` `grep` `glob` `calculator` `web_fetch` | 并发 | 只读 / 无状态；彼此没有先后依赖 |
| MCP 只读工具（名字不含 write/edit/create/move/delete/remove/rename/append/mkdir） | 并发 | 命名启发式；未知副作用时按保守侧处理 |
| `delegate`（非 `parallel` 形态） | 并发 | 每个子任务独立 thread + 独立 taskId；令牌预留在 SQLite 里原子 |
| `write_file` `edit_file` `bash` | 串行（保持顺序） | 有副作用，可能依赖前一个调用的结果 |
| `load_skill` `ask_parent` | 串行 | 都改本轮 runtime（skill / question），顺序敏感 |
| `delegate(parallel=[…])` | 串行（它内部已并发） | 避免嵌套并发把连接与预算打满 |

实现要点：

1. **连续的并发安全调用合成一组** `Promise.all`；遇到串行工具就是一道屏障，
   后面的组再重新开始。这样既拿到并发，又不破坏「写后读」的顺序。
2. **结果按原 `tool_calls` 下标回填**，`tool_call_id` 一一对应 —— 模型侧看到的
   顺序与它发出的一致。
3. `runtime.denied` / `runtime.question` / `runtime.skill` 的写入都是同步的
   （Node 单线程），并发批次里没有竞态。
4. `gateToolCall` 与账本写入保持同步：每个工具仍**各自过网关、各自落账**，
   并行不等于绕过判定。

## 2. MCP 并行连接

`connectMcp` 用 `Promise.all` 同时连所有 server，再按**配置顺序**汇总
`status` / `tools`。失败隔离不变（单个 server 挂了只进 `status.error`）。

- 好处：两个 server 的冷启动重叠，启动时间从 `t1 + t2` 变成 `max(t1, t2)`。
- `npx` 首次下载时的 npm cache 锁可能让两者部分排队 —— 最坏也只是回到串行，
  不会更差。

## 3. 让模型更愿意批量

`delegate` 的工具描述补一句：

> 多个互不依赖的子任务，在同一批里发多个 delegate 调用（或用 `parallel`），
> 它们会并行执行；不要一个一个等。

这是**模型行为引导**，不改任何调度代码，也不引入新工具。改描述会让装了
`delegate` 的 A/B 前缀缓存作废一次 —— 一次性成本，换来之后每轮的往返减少。

## 4. 缓存账

| 变化 | 谁的前缀作废 | 何时 |
|---|---|---|
| `delegate` 描述 | A / B | 升级后首次启动，一次 |
| `callTools` 并行 | 无 | 工具 schema 一个字节没动 |
| MCP 并行连接 | 无 | 工具清单与顺序不变 |

## 5. 不做

- 不改默认思考档（B/D 仍是 `high`）—— 那是质量与速度的取舍，交给使用者按任务调。
- 不缓存模型响应、不预判答案 —— 正确性优先。
- 不做「同一批里并发 delegate 的嵌套并发」—— 层层 `parallel` 会把连接与预算打满，
  `parallel` 自身已有 8 个上限。
- 不改 `ask_parent` 的暂停语义 —— 它是信息完整性机制，不是延迟来源。

## 6. 零 API 测试

1. 纯函数：`canRunToolInParallel(name, args)` —— 只读并发、写串行、MCP 命名启发式
2. 并发事实：两个假 MCP 只读工具各睡 50ms，同一批调用 → `maxActive === 2`
3. 顺序事实：两个假 MCP 写工具 → `maxActive === 1`，且执行顺序与调用顺序一致
4. 结果对应：并发批次返回的 ToolMessage 顺序与 `tool_calls` 下标一致
5. 回归：既有 240 个测试全绿（delegate / 网关 / 账本语义不变）

## 7. 可观测

- `HIVE_DEBUG=1` 时，每个工具仍打印 `tool <name>`；并行批次的时间线在日志里
  自然重叠。
- 不改 `/caps`、`/doctor` 的输出 —— 并行是执行层行为，不是能力变化。
