# hive v3 设计 —— agent 一等公民 + capability 层 + 沙箱

> 一句话：v2 把借调机制做完了，但 agent 仍然是「被 `delegate` 工具借起来的函数」。
> v3 把它提升为**可独立启动、可寻址、可续会话的实体**；工具从「按角色裁剪的白名单」
> 重构成**共享的 capability 层**；并补上 v0.1 起就欠着的**沙箱**。
>
> 本文只定方向与边界，不写实现。§7 的待拍板项定了之后再动代码。

## 0. 不改的（继承 v0.1 / v2）

1. `STABLE_PREFIX` 逐字节不变 —— 改一个字就是一次全盘缓存作废
2. 角色片挂用户消息末尾 —— 落在必然未命中的尾巴里，边际成本 ≈ 0
3. 权限收在执行层 —— 模型「答应不做」不算数，代码挡住才算数

## 1. 现状诊断：v2 留下的三处结构性问题

| # | 症状 | 根因 |
|---|---|---|
| 1 | B/C/D 只能由 A 通过 `delegate` 唤起，跑完即弃 | agent 只有「工具」这一个入口；`subagent.ts` 的 `runSubagent` 是一次性的 |
| 2 | B 的能力残缺（`tools: ['read_file','delegate']`） | 工具集绑在模块表上、按角色裁剪 |
| 3 | 越界检查只是 `tools.ts` 里的字符串前缀比较 | 没有能力网关，更没有隔离 |

v3 要做的三件事，正是把这三条各自升级：

- 1 → **每个 agent 可独立启动**
- 2 → **capability 共享 + 声明式装配**
- 3 → **沙箱（能力网关 + 隔离分级）**

## 2. agent 一等公民

### 2.1 `AGENTS` 从「权限表」升为「agent 定义」

现状 `AgentSpec` 只有 `id / title / home / mayCall / summary` —— 它只管「谁能借调谁」。
v3 扩成完整的 agent 定义：

```ts
interface AgentSpec {
  id: AgentId;
  title: string;
  home: string; // 主模块（决定角色片）
  capabilities: string[]; // v3：这个 agent 装哪些 capability
  think?: ThinkBudget; // v3：默认思考档（off/low/high）
  mayCall: AgentId[]; // 谁能借调谁（v2 保留）
  standalone: boolean; // v3：能否被 `hive --as` 独立启动
  summary: string;
}
```

关键：**能力（capabilities）从模块表搬到身份表**。模块只管「角色片 + 思考档」，
「能干什么」归身份 —— 这样同一个 agent 换角色不掉能力，同一角色换 agent 也不带能力走。

### 2.2 独立入口

| 命令 | 作用 |
|---|---|
| `hive --as B "…"` | 以 B 身份起一轮 / 起会话 |
| `hive --as B --continue` | 续 B 上一次的独立会话 |
| `hive delegate --from A --to B --goal "…"` | 显式借调（把 `/delegate` 命令搬到 CLI，便于脚本化） |

现状 `cli.ts` 的 `parse` 只有 `repl / run / doctor / help / version`，B/C/D 根本无法单独启动。

### 2.3 thread 可续：两类会话分家

| 类型 | thread 命名 | checkpoint |
|---|---|---|
| 借调子任务 | `main#C#t001-xxxx` | 跑完即弃（沿用 v2 的痕迹策略） |
| **独立会话** | `solo#B`（可续） | **保留**，`--continue` 靠它 |

这一条是对 v2 §5 痕迹策略的**分叉**：子任务弃 checkpoint 是为了不让 `memory.db` 膨胀；
独立会话必须留 checkpoint，否则「一个 agent 单独当产品用」就无从谈起。

## 3. capability 层

### 3.1 先说清楚矛盾：工具 schema 是前缀的一部分

v0.1 的第三条约束说「所有模块共享同一套工具定义」，理由是：**工具 schema 在 prompt 开头，属前缀的一部分**，
按模块换工具 = 换前缀 = 整个历史缓存作废。

但 v3 要让不同 agent 装不同能力 → 工具 schema 必然不同。这是**硬冲突**，必须正面解决。

**结论（对 v0.1 第三条的修正）**：缓存单位从「全局一套」改为「**每个 agent 一套**」。

- 每个 agent 的前缀 = `STABLE_PREFIX + 它的 capability 的 schema`
- 各 agent 各自缓存、互不影响
- 这不是退步：不同 agent 本来就是不同产品，各自冷启动一次本就该付

连带地，v0.1 的「工具要一次加齐，别边做边加」（怕全盘缓存作废）在 v3 被**取代**：
以后加一个 capability，作废的只是**装了它的那些 agent** 的缓存，不是全盘。

### 3.2 capability 是一个独立单元

```
capability = {
  name: string          // 'fs' | 'shell' | 'search' | 'web' | 'skill' | 'delegate'
  tools: Tool[]         // 它贡献给 agent 的工具 schema
  policy: PolicySpec    // 它需要什么权限（供 §4 的能力网关用）
}
```

首批候选：

| capability | 工具 | 权限 |
|---|---|---|
| `fs` | `read_file` / `write_file` / `edit_file` | `fs.read` / `fs.write`（限 roots） |
| `shell` | `bash` | `exec`（命令白名单） |
| `search` | `grep` / `glob` | `fs.read` |
| `web` | `fetch` / `browser` | `net`（域名白名单） |
| `skill` | 装载 playbook | 只读 |
| `delegate` | 借调（v2 已有） | 令牌 + 预算 |

agent 用 `capabilities: ['fs','search']` **声明式装配**，而不是在模块表里手写工具名。
这就是「任意一个 agent 单独拿出来都能用 bash/browser/grep/edit/skill」的落点。

## 4. 沙箱

### 4.1 能力网关：所有副作用走同一道门

```
action = { kind: 'fs.read'|'fs.write'|'exec'|'net', target, by: AgentId, taskId }
policy.check(action) -> allow | deny(reason) | ask
```

两层缺一不可：
- `AGENTS.capabilities` 决定「谁**能**发起这类动作」
- `policy.check` 决定「**这一次**准不准」

v2 的授权令牌（`grant.ts`）是「借调的钥匙」；v3 里它顺势扩为「agent 的身份凭证」，
两者合流到这道门上。

### 4.2 policy 四条

1. **默认拒绝**：没显式允许的一律不许（而不是默认放行 + 黑名单）
2. **最小权限**：每个 agent 只拿干活必需的那部分
3. **拦在执行层**：模型「答应不做」不算数
4. **可审计**：每次放行 / 拒绝都落账本（复用 `ledger`，加 `kind='policy'`）

> 现状对照：v0.1 只做了第 1 条的**一半**（`tools.ts` 的字符串前缀比较），
> 且是进程内检查 —— 挡不住符号链接、挡不住 agent 自己写脚本绕过。

### 4.3 隔离分级（分阶段，别一次到位）

| 级别 | 手段 | 何时上 |
|---|---|---|
| L0 | 进程内路径检查（现状） | 已有 |
| L1 | 能力网关 + roots / 命令 / 域名白名单 | **v3 M2** |
| L2 | 子进程 + 环境隔离（env 清理、cwd 锁定） | v3 之后 |
| L3 | 容器 / 微虚拟机（gVisor、Firecracker） | 产品化时 |

## 5. 通信：从「父调子」到「对称」

现状：A 调 `delegate` → 跑 B → 返回一个字符串（**一次性、单向、无续**）。

v3 目标：agent 之间可**往返**（B 能反问 A）、可**并行**（A 同时派 B 和 D）、可**寻址**（`@B`）。

最小可行做法：把 `HandoffResult` 从「终值」升级为「事件 / 可继续追加的会话」，
子会话变成能再接消息的会话（配合 §2.3 的可续 thread）。

⚠️ **这块最容易做成过度设计**。建议**先只做「可续」**，并行与广播留到 M3 之后。

## 6. 里程碑

- **M1（零 API）**：`AGENTS` 升为 agent 定义；`hive --as` 入口；独立会话 thread（`solo#X`）可续
- **M2（零 API）**：capability 层从模块表拆出来；接第一个真 capability（建议 `shell` 或 `search`）；
  能力网关 + L1 policy + 拒绝落账
- **M3（真机）**：沙箱分级调档；A→B 往返（不止一次性）；核账（每个 agent 独立跑时的命中率与成本）

## 7. 已拍板（2026-10-15）

| # | 议题 | 决定 | 落到哪 |
|---|---|---|---|
| 1 | agent 间通信 | **直接调用起步**：子会话从「一次性终值」升为可续会话；不上总线 / 广播 | §5 |
| 2 | capability 实例 | **共享实例**（同进程一套），policy 按 agent 身份区分权限 | §3.2 |
| 3 | 沙箱 | **不做固定档位，做成可配置**：roots / 命令白名单 / 域名 / 默认动作都从配置读 | §4 |
| 4 | 独立会话持久化 | 复用 `memory.db`，不单开库 | §2.3 |
| 5 | `standalone` 范围 | **全开**：A/B/C/D 都能 `hive --as` 独立启动 | §2.2 |

> 第 3 条的含义：沙箱**不是一个二选一的档位，而是一份可编辑的策略**。
> 默认给保守值（default deny），但使用者能在配置里改成宽松 —— 「能力与风险由谁平衡」交给使用者，
> 而不是框架替他拍死。落点：§4.1 的 `policy.check` 从配置读规则，不把规则写进代码。

## 8. 与 v2 的关系（不是推倒重来）

v2 的机制**全部保留**，只是各自的定位扩了一档：

| v2 的东西 | v3 里变成 |
|---|---|
| 授权令牌（借调的钥匙） | **agent 的身份凭证**（合流到能力网关） |
| 交接（一次性终值） | **可续会话** |
| 预算闸门（子任务一次） | **每个 agent 累计** |
| 模块栈（栈式恢复） | 不变 |
| 痕迹：子任务弃 checkpoint | 子任务弃 / **独立会话留**（见 §2.3） |
