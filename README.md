# hive

一个把「省 token」当第一性问题的 agent CLI：**一段逐字节不变的前缀 + 挂在消息末尾的角色模块 + 内置的 token 账本**。

TypeScript / langgraph.js。`npm i -g hive-agents` 之后一条 `hive` 就能开。

> 它不是又一个聊天壳子。它是从一批实测里长出来的：41 组样本量出
> **未命中 = (入 mod 64) + 64k** 这条几何律，又量出账单的形状 ——
> 可见输出只占总花费 3%、思考占 32%、未命中输入占 40%。
> 结论很反常识：**削「话长」动的是那 3%。**

---

## 装上

三种都行，都不需要 npm 账号：

```bash
npm i -g hive-agents                                       # npm registry
npm i -g github:dez-eng/hive-agents                        # 直接从 GitHub（会现场编译，约 35s）
npm i -g https://github.com/dez-eng/hive-agents/releases/download/v0.1.0/hive-agents-0.1.0.tgz
```

配 key —— **不配跑不起来**。在你要干活的目录里放一份 `.env`：

```bash
printf 'DEEPSEEK_API_KEY=sk-你的key\n' > .env
```

或者直接 `export DEEPSEEK_API_KEY=...`。需要 **Node ≥ 22.5**（用了内置的 `node:sqlite` 与 `process.loadEnvFile`）。

## 用

```bash
hive                      # 交互会话（主控 A）
hive --as B               # 以侦察身份独立启动；会话挂在 solo#B 上，可以续
hive --as C --continue    # 续 C 上一次的独立会话
hive run "3*7 等于几"      # 单轮，适合脚本
hive doctor               # 环境自检（账本、策略、工具 schema 字符数）
```

---

## 四条设计约束

前三条不是审美，是钱的形状决定的；第 4 条是 v3 对第 3 条的修正。

1. **system 前缀逐字节不变** —— 前缀一变，后面整段历史全部作废，等于每轮重付全价。
   `STABLE_PREFIX`（`src/core/prompt.ts`）改一个字符就要付一次「全盘作废税」，所以它**不进对话历史**，每轮临时拼在最前面。
2. **角色挂在用户消息末尾** —— 切模块只换尾部那几十 token，而最末尾那段本来就在「必然未命中」的尾巴里，边际成本 ≈ 0。
   反过来做（每个角色一份完整 system prompt）换一次角色就是整段历史作废。
3. **权限收在执行层** —— 模型「答应不做」不算数，代码挡住才算数。
4. **（v3 修正）工具 schema 按 agent 分套** —— 缓存单位从「全局一套工具」改为「**每个 agent 一套**」：
   各 agent 各自冷启动一次、互不影响；加一个能力只作废装了它的那些 agent。不同 agent 本就是不同产品。

---

## 八个工具，按身份装配

工具不写死在模块表里，而由 capability 声明式装配（`AGENTS[i].capabilities` → 该身份的工具集）。
**装了 ≠ 准干** —— 能不能用由能力网关判（下一节）。

| capability | 工具 | 说明 |
|---|---|---|
| `fs` | `read_file` `write_file` `edit_file` | `edit_file` 唯一匹配才动手，0 次/多次都拒绝并给出命中行号 |
| `search` | `grep` `glob` | 正则搜内容 / 通配符列文件（不跟符号链接，带 200ms 正则软超时） |
| `calc` | `calculator` | 无副作用，不进网关 |
| `shell` | `bash` | **默认全拒**，见「沙箱」一节 |
| `delegate` | `delegate` | 借调 / 在同一子会话里续跑（令牌 + 预算闸门） |
| `web` `skill` | — | 只声明，还没实现（贡献 0 token） |

各身份每轮为工具 schema 付的钱（`/caps` 随时可查）：

| 身份 | 工具数 | 字符/轮 |
|---|---|---|
| A 主控 | 8 | 3070 |
| B 侦察 | 7 | 2827 |
| C 修复 | 4 | 1312 |
| D 审计 | 6 | 2109 |

---

## 沙箱：能力网关

所有副作用走同一道门，两个判据缺一不可：

- `AGENTS[by].capabilities` —— 谁**能**发起这类动作
- 规则表 —— **这一次**准不准（默认 deny）

规则从 `.hive/policy.json` 读，七个 `HIVE_POLICY_*` 环境变量可覆盖；**配置写坏就整份退回默认 deny**（绝不因为手滑而放行）。

```jsonc
{
  "default": "deny",
  "roots": ["."],                                        // fs / search 的作用域
  "agents": {
    "A": { "fs.read": "allow", "fs.write": "allow" },
    "B": { "fs.read": "allow", "fs.write": "deny" }      // 装了 fs，但只给读
  },
  "exec": { "allowCommands": [] },                       // 命令白名单，默认空
  "net":  { "allowDomains": [] },
  "ignore": [".git", "node_modules", "dist", ".hive"]
}
```

### `bash` 默认是跑不了的

白名单为空，谁都跑不了。要放开就往 `exec.allowCommands` 里填 —— 支持细到前几个词：

```jsonc
"exec": { "allowCommands": ["git status", "node --version"] }
// 写 "git"  = 整个 git 都放行
// 写 "*"   = 不限（自担风险）
```

**不给 shell 执行**：`spawn` 直接跑命令，不走 `sh -c` —— 走 shell 的话白名单形同虚设（`ls; rm -rf /` 的第一个词是 `ls` 就被放行了）。
代价是管道 `|`、重定向 `>`、通配符 `*` 都不支持。

另外两件：**子进程只拿到一份最小环境**（`DEEPSEEK_API_KEY` 这类名字含 `KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL` 的一律抹掉，逃生舱 `HIVE_BASH_ENV_KEEP` 也过不了这层过滤）；路径判定**解析真实路径**（项目里的符号链接指向外面会被拒）。

### 诚实说边界

这是 L1：防的是「手滑 + 模型乱来 + 事后可查」，**不是防恶意**。

- 信任一个命令 = 放开那个命令的全部能力。信任了 `node`，`node -e "…"` 就能读写任意文件、绕过网关的 `fs.write`
- 被信任的命令能 `cat .env` 文件本身（env 清理堵的是「继承」，不是「读取」）
- 所有检查都在同一个进程、同一个用户、同一份文件系统权限里，挡不住「agent 自己写脚本绕过」
- 每一次放行与拒绝都落账（`tag='policy'`，`/policy log` 可查），但仅此而已

真正的隔离（容器 / 微虚拟机）在产品化清单上。

---

## 多 agent：A 主 + B/C/D 副，每个都能单独启动

| 身份 | 角色 | 主模块 | 可借调 | 单独启动 |
|---|---|---|---|---|
| A | 主控：持会话、精简、再分配 | `assistant` | B / C / D | `hive --as A` |
| B | 侦察：只陈列事实 | `recon` | C / D | `hive --as B` |
| C | 修复：按目标改文件 | `fix` | — | `hive --as C` |
| D | 审计：复核结论与事实 | `audit` | — | `hive --as D` |

- **借调可嵌套**（A→B→C）。副 agent 拿不到调用方的历史 —— 子会话是独立 thread，物理隔离而非提示词叮嘱
- **结构化交接**：只传 `{goal, slice, expect, budget}`，schema 里没有「原文」入口
- **令牌**：A 借调时自动签发，`/grant` 可手动收紧；校验拦在执行层，模型看不到也绕不过
- **独立会话**：挂 `solo#<身份>`，留 checkpoint，可以 `--continue` 接着聊
- **模块栈**：`/use` 压栈、`/pop` 弹栈，借调结束回到原角色（栈式恢复，不是覆盖）

---

## 一道轮内的两道护栏 + 自动压缩

- **工具批数上限 16**（`HIVE_TOOL_STEPS`，0 = 不限）：到顶就**安静结束本轮**，而不是让模型继续试
- **token 闸门 20000**（`HIVE_TURN_BUDGET`，0 = 不封顶）：闸门在 `callModel` **之前**，超了不发请求

两者触发时都会打一句「说『继续』就接着跑」。长任务的正常姿势是**多轮推进**：每轮是一笔可核对的消费，而不是一个越来越大的黑洞。

历史太长会**自动压缩**：默认以上一轮的真实入 token 为尺子（超 24000 压一次），保留最近 16 条（且切点对齐到用户消息边界），丢掉的部分压成一条要点摘要。压缩改的是 prompt 中段，所以它必然付一次前缀重算 —— 这是刻意的取舍，发生时 UI 会明说。

---

## 命令（26 个）

| 命令 | 作用 |
|---|---|
| `/cost` | 账单：本轮 / 会话 / 今日 / 历史 |
| `/turn` `/turn 3` `/turn 2-5` | 本会话逐轮 / 单轮明细 / **某段合计** |
| `/find 关键词` | 跨历史搜轮次 |
| `/caps` | 各身份装了什么能力（工具 schema 字符数） |
| `/policy` `/policy log` | 当前生效规则 / 最近的判罚（放行与拒绝都记） |
| `/modules` `/use <id>` | 列模块 / 切模块（压栈） |
| `/stack` `/pop` | 看模块栈 / 弹一层 |
| `/as A\|B\|C\|D` | 切身份（调试用） |
| `/delegate <身份> <目标>` ／ `/delegate --continue <taskId> <追加>` | 交办一次 / 续跑同一子会话（taskId 见 `/handoffs`） |
| `/grant <身份> <预算>` `/budget` `/handoffs [n]` | 令牌、余额、交接记录（记录里带子会话 thread） |
| `/tail on\|off` `/status on\|off` | 尾部角色片开关 / 底部状态行开关 |
| `/new` `/history` | 开新会话（冷缓存） / 存档点 |
| `/anatomy` `/misscheck` `/lenstat` `/ledger [n\|agents]` `/thinktest` | 诊断类（`/help all` 才列；`/ledger agents` 按身份核账） |

底部常驻一行，宽度不够从右往左丢段、绝不换行：

```
本轮 $0.000043 思考32% 拒1 k=2 │ 上下文 7.4k 命中92% │ 会话 $0.0012 12轮 均$0.0001/轮 │ hive · deepseek-flash · 谷 · 通用+尾 │ 历史 $0.0056 41行
```

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | **必填** |
| `DEEPSEEK_MODEL` | `deepseek-flash` | 需能在 `src/core/cost.ts` 的 `PRICE` 里找到 |
| `HIVE_TOOL_STEPS` | `16` | 一次 `run()` 内工具批数上限，0 = 不限 |
| `HIVE_TURN_BUDGET` | `20000` | 一轮 token 闸门，0 = 不封顶 |
| `HIVE_COMPRESS_AT` | `24000` | 上一轮入 token 超它才压缩，0 = 从不压 |
| `HIVE_COMPRESS_KEEP` | `16` | 压缩后保留最近多少条消息 |
| `HIVE_POLICY` | `.hive/policy.json` | 策略文件路径 |
| `HIVE_POLICY_DEFAULT` / `_ROOTS` / `_READ` / `_WRITE` / `_EXEC` / `_NET` | — | 覆盖策略（`READ`/`WRITE`/`EXEC`/`NET` 是**白名单**语义：列出的允许，其余收回） |
| `HIVE_BASH_ENV_KEEP` | 空 | 额外透传给子进程的变量名（仍过敏感词过滤） |
| `HIVE_MAX_OUT` | `0` | 输出封顶（**实测封顶只会切断答案，省不了钱**） |
| `HIVE_LEDGER` | `costs.db` | 账本路径（默认在工作目录） |
| `HIVE_MEMORY` | `.hive/memory.db` | langgraph checkpoint |

## 账本

`node:sqlite`（Node 内置，零外部依赖）。表结构与早期 Python 版对齐，**能直接读那批历史账**：

```sql
ledger(ts, day, run_id, thread_id, model, band, tag, module, calls,
       in_tok, cache_hit, out_tok, reason_tok, user_chars,
       user_head, out_head, cost_usd, style_on,
       agent, task_id, budget_tok, budget_hit,
       target, verdict, reason)        -- v3：能力网关的判罚行（tag='policy'）
```

另外三张表：`tokens`（授权令牌）、`handoffs`（交接记录，v3 M3 起带子会话 `thread` —— 续跑靠它回到同一个 checkpoint）。

`/misscheck` 会逐对检查几何律在你的真实数据上是否仍然成立 —— 这是唯一能证明「前缀缓存真的命中了」的手段，比任何猜测都硬。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test（自带 tsx loader）
npm run build       # 产物在 dist/
npm run dev         # 直接跑 src/cli.ts
```

测试全部零 API（假模型 / 临时目录 / 纯函数），所以改代码不必花一分钱。

## 路线图

- [x] v0.1 缓存友好前缀 + 尾部角色槽位 + token 账本 + 几何律检验
- [x] v2 多 agent：令牌、结构化交接、模块栈、预算闸门、思考分级
- [x] v3 M1 agent 一等公民：`hive --as`、独立可续会话
- [x] v3 M2 capability 层 + 能力网关（L1 policy）+ 判罚落账
- [x] v3 M2.5 实用化四件：`edit_file`、循环护栏、上下文压缩、`bash`
- [x] v3 M2.6 沙箱加固：子进程 env 最小化、路径解析真实路径
- [x] v3 M3.1 子会话可续（父驱动往返）+ 按 agent 核账（`/ledger agents`）
- [ ] v3 M3.5 并行借调、B 主动反问 A、`@` 寻址
- [ ] 以后：`web` / MCP / skill / 多 provider；容器级隔离

设计与实测记录都在 `docs/` 里（V2-PLAN、V3-PLAN、V3-M2-DESIGN、V3-M2.5-DESIGN、V3-M2.6-DESIGN、V3-M3-DESIGN）。

## License

[MIT](LICENSE) © 2026 dez-eng
