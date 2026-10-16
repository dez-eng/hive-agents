# hive v3 · M2 设计 —— capability 层 + 能力网关（L1 policy）

> 一句话：M1 让 agent「存在」了，M2 让「它能用什么」变成可装配的数据，
> 并且**每次副作用都过同一道门**——放行或拒绝都留痕。
>
> 本文是 V3-PLAN §3 / §4 的落地细化，只定接口与边界，不写实现。
> §10 的待拍板项定了之后再动代码。

## 0. 不改的（继承 V3-PLAN §0）

1. `STABLE_PREFIX` 逐字节不变 —— **M2 有一处例外，已拍板**：第 24 行那句工具说明
   补上「搜索（grep/glob）」（2026-10-16，见 §10 第 4 项）。这是**一次性**的全盘
   缓存作废税，改完这一行之后仍按铁律冻结。
2. 角色片挂用户消息末尾 —— 它在必然未命中的尾巴里，边际成本 ≈ 0
3. **权限收在执行层** —— 模型「答应不做」不算数，代码挡住才算数
4. 缓存单位 = **每个 agent 一套**（V3-PLAN §3.1 已拍板），M2 把这条落到代码

## 1. 现状：M2 起点的四处硬伤

| # | 症状 | 位置 |
|---|---|---|
| 1 | `AGENTS[i].capabilities` 只是**声明**，没有任何代码读它 | `modules.ts` 写了，`agent.ts` 不用 |
| 2 | 「能用什么工具」仍写在**模块表**里（`AgentModule.tools`），且按模块裁剪 | `modules.ts` + `agent.ts` 的 `callTools` |
| 3 | 三档模型**全部** `bindTools(ALL_TOOLS)` —— 与「每个 agent 一套」直接冲突 | `agent.ts` 的 `buildGraph` |
| 4 | 越界检查是 `tools.ts` 里两行字符串前缀比较，没有网关、没有落账 | `tools.ts` 的 `read_file` / `write_file` |

实测基线（本机跑 `toolsChars()`）：`ALL_TOOLS` = **1369 字符 ≈ 456 token**，
四个 agent 现在**每人每轮**都把这 456 token 发一遍（尽管 C 只能用其中两个工具）。

## 2. capability 层

### 2.1 单元结构（新文件 `src/core/capability.ts`）

```ts
export interface Capability {
  id: CapabilityId;        // 'fs' | 'search' | 'shell' | 'web' | 'skill' | 'calc' | 'delegate'
  title: string;           // 显示名，/caps 里用
  summary: string;         // 一行说明
  tools: Tool[];           // 它贡献的工具 schema —— **顺序即前缀顺序，不许乱**
  needs: ActionKind[];     // 它可能发起的动作类型（§3.1），供网关与 /policy 展示
}
```

`needs` 是「这个 capability 会碰什么」的静态声明（人看的、审计用的）；
**它不参与判定** —— 判定只看 `AGENTS[i].capabilities` + policy（§3.2）。

### 2.2 注册表（M2 首批）

| capability | 工具 | needs | M2 状态 |
|---|---|---|---|
| `fs` | `read_file` / `write_file` | `fs.read` / `fs.write` | 拆出现有工具 |
| `search` | `grep` / `glob` | `fs.read` | **M2 的真 capability（新工具）** |
| `calc` | `calculator` | —（无副作用） | 拆出现有工具 |
| `delegate` | `delegate` | `delegate` | 拆出现有工具（闸门仍是令牌，见 §3.7） |
| `shell` | `bash` | `exec` | **M2 不实现**（表里留声明，`tools: []`） |
| `web` | `fetch` / `browser` | `net` | **M2 不实现**（同上） |
| `skill` | 装载 playbook | — | **M2 不实现**（同上） |

留空声明的意义：`AGENTS` 里现在能写 `capabilities: ['shell']`，
装配时它贡献 0 个工具（也就 0 token），但 `/caps` 会告诉你「声明了、还没实现」。
比凭空冒出一个能力、或者名字拼错静默生效要好。

### 2.3 装配规则

```ts
export function toolsFor(agent: AgentId): Tool[]   // 该 agent 的工具集（去重，按 2.2 表序）
export function capabilityOf(tool: string): CapabilityId | undefined
```

- 只读 `AGENTS[agent].capabilities`，**不再看模块**
- 工具顺序 = capability 注册表顺序 × 内部顺序 —— 固定，否则前缀字节变
- `AGENTS` 因此要调整（M2 后）：

| agent | capabilities（M2 后） | 变化 |
|---|---|---|
| A | `fs` `search` `calc` `delegate` | +search（新能力）、+calc（原模块表里有算数） |
| B | `fs` `search` `delegate` | **+fs**（侦察必须能读文件 —— 修 V3-PLAN §1 的第 2 条硬伤） |
| C | `fs` | 只能读写文件，连 grep 都没有 |
| D | `fs` `search` | 审计要能读、能搜 |

⚠ 关键点：**「装了什么」不等于「准干什么」**。
B/D 装上了 `fs` 就拿到了 `write_file` 的 schema，但 policy 默认只给它们 `fs.read` ——
真去写会被网关拒并落账。这是「两层」的正常形态，不是漏洞。

### 2.4 模块表的 `tools` 退役

`AgentModule.tools` 删除（连带 `MODULES` 里的字面量）。
模块从此只剩三件事：**角色片 + 思考档 + 归属**。
`test/modules.test.ts` 里对 `tools` 的断言要改。

### 2.5 装配带来的执行层顺序（`callTools`）

```
1. 工具存在吗                              → 否：ERROR: 没有这个工具
2. 在 toolsFor(runtime.agent) 里吗         → 否：ERROR: 身份 X 没装 <tool>   ← 判据是身份，不是模块
3. policy.check(action) 放行吗             → 否：落账 + ERROR: 被策略拒绝（reason）
4. 特判 delegate → 令牌 + 预算（v2 原路）
5. 执行工具（工具内部对 roots 再兜底一次）
```

第 2 步与第 3 步是**两道不同的门**：前者是「有没有这件工具」，后者是「这一次准不准」。

## 3. 能力网关（新文件 `src/core/policy.ts`）

### 3.1 action 与 verdict

```ts
export type ActionKind = 'fs.read' | 'fs.write' | 'exec' | 'net' | 'delegate';

export interface Action {
  kind: ActionKind;
  target: string;            // 文件路径 / 命令 / 域名 / 借调目标身份
  by: AgentId;               // 谁在发起
  capability: CapabilityId;  // 从哪个 capability 来的
  tool: string;              // 触发它的工具名（便于落账）
  threadId?: string;
  taskId?: string;
}

export type Verdict =
  | { allow: true }
  | { allow: false; reason: string; code: 'no-capability' | 'out-of-roots' | 'denied' | 'ask-pending' };
```

`code` 让落账能按原因分类统计（「被拒了多少次、都是哪种」是可回答的问题）。

### 3.2 两个判据，缺一不可

- `AGENTS[by].capabilities` 含这个 action 所属的 capability → **谁「能」发起这类动作**
- policy 规则这一条是 `allow` → **这一次「准不准」**

两条都不满足就 `no-capability`；只满足第一条但规则是 deny 就是 `denied`。
**网关自己再检查一次 capability**（哪怕 §2.5 第 2 步已经查过）：
网关是这个能力的唯一真相，别的地方漏了它也能兜住。

### 3.3 配置：`.hive/policy.json` + 环境变量覆盖

配置文件（不存在就用 §3.4 的内置默认，不报错）：

```jsonc
{
  "default": "deny",                  // 未列出的动作一律 deny
  "roots": ["."],                     // fs/search 的作用域（相对 cwd；也可写绝对路径）
  "agents": {
    "A": { "fs.read": "allow", "fs.write": "allow" },
    "B": { "fs.read": "allow", "fs.write": "deny" },
    "C": { "fs.read": "allow", "fs.write": "allow" },
    "D": { "fs.read": "allow", "fs.write": "deny" }
  },
  "exec": { "allowCommands": [] },    // 命令白名单，M2 空（没有 shell capability）
  "net":  { "allowDomains": [] },     // 域名白名单，M2 空
  "ignore": [".git", "node_modules", "dist", ".hive"]   // search 遍历时跳过
}
```

环境变量覆盖（CI / 临时放宽用，**优先于文件**）：

| 变量 | 作用 |
|---|---|
| `HIVE_POLICY` | 配置文件路径（默认 `.hive/policy.json`） |
| `HIVE_POLICY_DEFAULT` | `allow` / `deny`，覆盖 `default` |
| `HIVE_POLICY_ROOTS` | 用 `path.delimiter` 分隔多根（Windows `;`），覆盖 `roots` |
| `HIVE_POLICY_READ` | 逗号分隔的 agent 名单，覆盖 `fs.read` |
| `HIVE_POLICY_WRITE` | 同上，覆盖 `fs.write` |
| `HIVE_POLICY_EXEC` | 同上，覆盖 `exec` |
| `HIVE_POLICY_NET` | 同上，覆盖 `net` |

**配置坏了怎么办**：解析失败 → 打一行警告 + **整份退回内置默认（default deny）**。
绝不能因为配置文件写错就变成默认放行。

### 3.4 内置默认（无配置文件时生效）

就是 §3.3 那份 JSON 的内容：`default: deny`、`roots: ["."]`、
A 读写、B 只读、C 读写、D 只读、exec/net 空、ignore 四条。
与现状的**唯一差别**：现在 `write_file` 对谁都放行（只要在项目目录内），
M2 后 B/D 写会被拒。这是收紧，符合 V3-PLAN §4.2「默认拒绝」。

### 3.5 检查粒度：**一次工具调用 = 一次检查 = 一行账**

不是每个文件路径一次（否则一次 grep 就是几百行账）。
同一次调用内部遍历多少路径，网关不管 —— 它管的是「这次调用被允许了吗」。

### 3.6 `ask` 在 M2 怎么办

M2 **不实现交互式确认**（REPL 里停下来问用户会和流式输出、非 TTY 的 `run` 模式打架）。
三态枚举先留着，执行层把 `ask` **当 deny 处理**，但落账时 `verdict` 写 `ask-pending`，
于是「哪些策略本该问、现在被硬拒了」是可查的，M3 有交互通道时再真问。

### 3.7 delegate 与网关的关系

`delegate` 是 capability，但它的闸门是 **v2 的令牌 + 预算**（`grant.ts`），M2 **不搬家**。
网关只对 delegate 做一条轻检查（`mayCall`），令牌与预算仍归 `runSubagent`。
V3-PLAN §8 说的「令牌合流到能力网关」是 M3 的事。

## 4. `search` capability（M2 唯一的新工具对）

### 4.1 契约

| 工具 | 入参 | 出参 |
|---|---|---|
| `grep` | `pattern`（正则）、`path?`（限定子树）、`glob?`（限定文件名）、`maxResults?` | `相对路径:行号: 该行内容`，逐行 |
| `glob` | `pattern`（`*` / `**` / `?`）、`maxResults?` | 相对路径列表，一行一条 |

### 4.2 上限（工具结果必然全价未命中 —— 这个数比 `READ_LIMIT` 更要紧）

- `grep`：最多 **40 行 / 3000 字符**，超出截断并在末行写 `（截断，共 N 处）`
- `glob`：最多 **80 条**
- 单文件读入上限 **64 KB**（超了跳过，一行 `（跳过 >64KB: path）`）
- 总扫描文件数上限 **4000**（超了停，写明「已扫 N 个文件后停止」）
- 跳过：`policy.ignore` 里的目录名、二进制文件（读到 `\0` 即判二进制）

### 4.3 schema 文案的 token 税

工具 schema 是前缀的一部分，**每个装了它的 agent 每轮都在付**。
所以两个工具的描述各**一行、不超过 40 字**，参数描述不超过 12 字。
预算：grep ≤ 300 字符、glob ≤ 280 字符（含 schema JSON）。写完要用 `toolsChars()` 复核。

### 4.4 实现选择

- `grep`：自己遍历（`readdirSync` + 逐文件读 + 正则），**不依赖外部 `rg`**（本机没有；也不能假设用户有）
- `glob`：自己把 glob 模式编译成正则（先转义、再还原 `**` → `.*`、`*` → `[^/]*`、`?` → `[^/]`），
  **不用** `fs.globSync`（Node 22 里还是 experimental，且与 Windows 路径分隔符的
  行为没定型）
- 正则来自模型，可能灾难性回溯：加**每文件 200 ms 的软上限**（超时按未匹配处理，记一次 `（超时: path）`）

## 5. 落账（复用 `ledger`，`tag='policy'`）

V3-PLAN §4.2 第 4 条已定「复用 ledger，加 `kind='policy'`」。落列：

| 列 | policy 行里的含义 |
|---|---|
| `tag` | `'policy'` |
| `module` | **capability id**（复用该列） |
| `agent` | 谁发起（`by`） |
| `thread_id` / `task_id` | 会话 / 子任务（可空） |
| `in_head`（即 `user_head`） | 动作描述，如 `fs.write .hive/x`（截断 50 字，复用现列） |
| **`target`**（新增列） | 动作目标原文（截断 80 字） |
| **`verdict`**（新增列） | `allow` / `deny` / `ask-pending` |
| **`reason`**（新增列） | 拒绝原因 / 命中哪条规则 |

三个新列都用 `ALTER TABLE ... ADD COLUMN ... DEFAULT ''`，与 v2 的补列模式一致（O(1)，老库照读）。
`cost_usd` / token 列在 policy 行里全填 0 —— 它不花钱，但它解释钱花在哪。

放行也记（V3-PLAN 已定）：量 = 工具调用次数，可控；所有统计查询都按 `tag='turn'` 过滤，
所以 policy 行**不会**污染 `/cost`、`/turn`、footer 的轮次与均值。

## 6. 代码改动清单（文件级）

| 文件 | 改动 |
|---|---|
| `src/core/capability.ts` | **新增**：`Capability`、`CAPABILITIES`、`toolsFor(agent)`、`capabilityOf(tool)` |
| `src/core/policy.ts` | **新增**：`Action` / `Verdict` / `loadPolicy()` / `check(action)` / `rootsOf()` / `withinRoots()` |
| `src/core/search.ts` | **新增**：`grepTool` / `globTool`（及遍历与 glob→RegExp 编译） |
| `src/core/modules.ts` | 删 `AgentModule.tools`；`AGENTS` 的 `capabilities` 按 §2.3 调整；加 `calc` 到 `CapabilityId` |
| `src/core/tools.ts` | `ROOT` 换成 `policy.roots`；越界检查改调 `policy.check`（工具内兜底）；不再导出 `ALL_TOOLS`（改由 capability 层汇总） |
| `src/core/agent.ts` | `buildGraph` 按 `agent × think` 建 12 个实例；`GraphRuntime` 加 `agent`；`TurnRequest` 加 `agent: AgentId`；`callTools` 换成 §2.5 的五步 |
| `src/repl.ts` / `src/commands.ts` | 构造 `TurnRequest` 处传 `agent: currentAgent(state)` |
| `src/core/subagent.ts` | 子任务 `TurnRequest` 的 `agent` = 被借调身份 `as` |
| `src/core/ledger.ts` | 三个新列 + `insertPolicy()` + `recentPolicy(limit)` |
| `src/commands.ts` | 新命令 `/policy`（当前生效规则）、`/policy log`（最近判罚）、`/caps`（每个 agent 装了什么 → 几个工具、多少字符） |
| `src/ui/footer.ts` | 可选：本轮有拒绝时最右侧加一段 `拒 N`（无拒绝则完全不出现；宽度不够照旧从右往左丢） |

## 7. 缓存影响测算

**每个 agent 的前缀 = `STABLE_PREFIX` + 自己那套工具 schema。**
工具 schema 由 §2.3 决定；`think` 档走 `modelKwargs`（请求体，不进 prompt），
所以**同一个 agent 的三档思考共用一份前缀缓存**。

| agent | M2 后的工具 schema（字符，估算） | ≈ token | 现状 | 差 |
|---|---|---|---|---|
| A | calc 243 + fs 516 + search ~580 + delegate 610 = **1949** | 650 | 456 | **+194** |
| B | fs 516 + search ~580 + delegate 610 = **1706** | 569 | 456 | +113 |
| C | fs 516 = **516** | 172 | 456 | **−284** |
| D | fs 516 + search ~580 = **1096** | 365 | 456 | −91 |

（search 的 580 是 §4.3 的预算上限，实测要复核。）

三件事要说清楚：

1. **一次性冷启动税**：M2 上线后每个 agent 的第一轮全价重算一次（前缀变了），之后稳态。
2. **C 是最大受益者**（每轮 −284 token 输入）：它在现有配置下背了 456 token 的工具定义、
   却只能用其中 516 字符的两个。C 是改文件的主力，这个节省会反复兑现。
3. **A 变贵是「让 A 也能自己搜」的价钱**。不想要就把 `search` 从 A 的 `capabilities` 里摘掉
   —— 这是**配置级决定**，改一行数据，不用动代码。
4. 因为 §10 第 4 项拍板要动 `STABLE_PREFIX` 那一行，四个 agent 的前缀**都会**变。
   这与工具集变化叠加，仍然只是各自冷启动一次，不会多付一次。

## 8. 测试计划与验收

新增（全部零 API，假模型/临时目录）：

| 文件 | 覆盖 |
|---|---|
| `test/capability.test.ts` | `toolsFor` 对四个 agent 的结果；顺序稳定（连跑两次同字节）；与 `AGENTS.capabilities` 一致；`shell`/`web`/`skill` 声明为空不贡献工具 |
| `test/policy.test.ts` | 默认 deny；`roots` 越界拒；env 覆盖优先级；坏配置退回默认 deny；`ask` → `ask-pending` + 实际拒绝；delegate 的 `mayCall` 轻检查 |
| `test/search.test.ts` | grep 命中/截断/跳过 ignore/跳过二进制/大文件；glob `**` 语义；越界路径拒 |
| `test/ledger-policy.test.ts` | 三个新列读写；老库（无这三列）能补列并照读；`/cost` 的轮次统计不被 policy 行污染 |

验收标准：

1. `npm test` 与 `npm run typecheck` 全绿（93 项 + 新增）
2. `hive --as D` 起会话 → `/caps` 显示 D 装了 fs/search（4 个工具、约 1.1k 字符）
3. 让 C 去写文件 → 成；让 D 去写文件 → 被拒，且 `/policy log` 里能看到 `deny` 行
4. `grep ../..` 之类的越界 → 被拒 + 落账，**不进模型、不花钱**
5. 真机跑一轮 A：确认前缀命中曲线符合 §7 的预期（这条放 M3 用真 API 复核）

## 9. 不做的（M2 边界）

- 不实现 `shell` / `web` / `skill` 的真工具（只留声明）
- 不做进程外隔离（L2：子进程、env 清理、cwd 锁定）→ M3
- 不做 A→B 往返与并行借调 → M3
- 不搬 `delegate` 的令牌体系进网关 → M3（V3-PLAN §8）
- `STABLE_PREFIX` **只动第 24 行那一句**（§10 第 4 项的拍板结论），其余逐字节不变
- 不改 `READ_LIMIT`、不改思考档映射、不改账本既有列的含义

## 10. 已拍板（2026-10-16）

| # | 议题 | 决定 | 落到哪 |
|---|---|---|---|
| 1 | capability 粒度 | **粗粒度**：`fs` 一个单元含读+写，权限差异全交 policy（接受 B/D 白背 `write_file` 的 286 字符 schema） | §2.2 / §3.2 |
| 2 | B/D 装不装 `fs` | **装**：能读文件，写被 policy 拒（修掉 V3-PLAN §1 第 2 条硬伤） | §2.3 |
| 3 | `grep` 形态 | **正则 + 五项上限**：40 行 / 3000 字符 / 单文件 64 KB / 4000 文件 / 每文件 200 ms 软超时 | §4.2 |
| 4 | `STABLE_PREFIX` 那句工具说明 | **补上「搜索（grep/glob）」** —— 准确性优先，接受一次全盘缓存作废 | §0.1 / §7 |
| 5 | M2 注册表范围 | 只做真能用的四个（`fs`/`search`/`calc`/`delegate`），`shell`/`web`/`skill` 留空声明 | §2.2 |
| 6 | footer 的 `拒 N` | 加 —— 仅在出现拒绝时显示在最右侧，宽度不够先丢它 | §6 |

> 第 4 项的代价是明确的：四个 agent 的前缀都要重算一次（工具集本来就都变了，
> 所以这条**不额外增加**冷启动次数）。改完之后那一行重新冻结。
