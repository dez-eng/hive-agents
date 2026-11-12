# hive

[![CI](https://github.com/dez-eng/hive-agents/actions/workflows/ci.yml/badge.svg)](https://github.com/dez-eng/hive-agents/actions/workflows/ci.yml)

一个把「省 token」当第一性问题的 agent CLI：**一段逐字节不变的前缀 + 挂在消息末尾的角色模块 + 内置的 token 账本**。

TypeScript / langgraph.js。`npm i -g hive-agents` 之后一条 `hive` 就能开。

> 它不是又一个聊天壳子。它是从一批实测里长出来的：41 组样本量出
> **未命中 = (入 mod 64) + 64k** 这条几何律，又量出账单的形状 ——
> 可见输出只占总花费 3%、思考占 32%、未命中输入占 40%。
> 结论很反常识：**削「话长」动的是那 3%。**

---

## 装上

两种都行，都不需要 npm 账号：

```bash
npm i -g github:dez-eng/hive-agents                        # 直接从 GitHub（会现场编译，约 35s）
npm i -g https://github.com/dez-eng/hive-agents/releases/download/v4.7.0/hive-agents-4.7.0.tgz
```

> `npm i -g hive-agents`（npm registry）暂时还不行 —— 包还没推到官方源。
> 用上面两条之一，装出来的是同一份东西。

配 key —— **不配跑不起来**。启动时按优先级找三处 `.env`：

1. 当前目录 `.env`（项目级，最高）
2. `~/.hive/.env`（用户级）
3. 包安装目录的 `.env`（全局装一次，从任意目录都能用）

```bash
printf 'DEEPSEEK_API_KEY=sk-你的key\n' > .env
```

shell 里 `export DEEPSEEK_API_KEY=...` 优先级最高，不会被任何文件覆盖。
都没有时 hive 会列出查过的路径并以退出码 2 退出，不会抛 stack。
需要 **Node ≥ 22.5**（用了内置的 `node:sqlite` 与 `process.loadEnvFile`）。

## 用

```bash
hive                      # 交互会话（主控 A）—— 启动时先选 1) 正常终端 / 2) 隐私窗口
hive init                 # 生成 .env.example / .hive/policy.json / hive.config.example.json / .hive/skills/example.md
hive --as B               # 以侦察身份独立启动；会话挂在 solo#B 上，可以续
hive --as C --continue    # 续 C 上一次的独立会话
hive run "3*7 等于几"      # 单轮，适合脚本
hive privacy              # 直接进隐私窗口（完整终端，防录屏）
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

## 工具按身份装配

工具不写死在模块表里，而由 capability 声明式装配（`AGENTS[i].capabilities` → 该身份的工具集）。
**装了 ≠ 准干** —— 能不能用由能力网关判（下一节）。

| capability | 工具 | 说明 |
|---|---|---|
| `fs` | `read_file` `write_file` `edit_file` | `edit_file` 唯一匹配才动手，0 次/多次都拒绝并给出命中行号 |
| `search` | `grep` `glob` | 正则搜内容 / 通配符列文件（不跟符号链接，带 200ms 正则软超时） |
| `calc` | `calculator` | 无副作用，不进网关 |
| `shell` | `bash` | **默认全拒**，见「沙箱」一节 |
| `delegate` | `delegate` | 借调 / 续跑同一子会话 / `parallel` 并发交办（令牌 + 预算闸门） |
| `mcp` | `mcp__<server>__<tool>` | 外部 MCP server（启动时冻结清单；`mcp.allowServers` 白名单） |
| `skill` | `load_skill` | 装载方法论文本（清单启动时冻结；**文本贴用户消息末尾，不进前缀**） |
| `ask` | `ask_parent` | 子任务中途向父会话提问（本轮暂停；父用 `delegate(resume=…)` 回答） |
| `web` | `web_fetch` | GET 网页 / HTTP 文本；**默认不装**，配 `web.allowDomains` 才装配（域名白名单 + 只读文本 + 字节上限） |

各身份每轮为工具 schema 付的钱（`/caps` 随时可查；下表只算默认装配的内置工具 ——
MCP、`load_skill` 与 `web_fetch` 按配置动态增加）：

| 身份 | 工具数 | 字符/轮 |
|---|---|---|
| A 主控 | 8 | 3615 |
| B 侦察 | 8 | 3644 |
| C 修复 | 5 | 1584 |
| D 审计 | 7 | 2381 |

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

**Windows 上的 `.cmd`**：`npm` / `npx` / `yarn` / `pnpm` 实际是 `.cmd`，Node 的 `spawn(bin)`
不会按 `PATHEXT` 解析，直接 `ENOENT`。hive 先解析真实文件，`.cmd/.bat` 只经由
`cmd.exe /d /s /v:off /c` 启动，每个参数单独加引号；含 `"` / `%` / 换行的参数会被拒绝
（cmd 无法安全转义）。白名单仍按原始命令名判定 —— 放行 `npm` 即可，不用写 `npm.cmd`。

另外三件：**子进程只拿到一份最小环境**（`DEEPSEEK_API_KEY` 这类名字含
`KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL` 的一律抹掉，逃生舱 `HIVE_BASH_ENV_KEEP` 也过不了
这层过滤；但补齐了 Windows 上 npm/git 需要的 `APPDATA` / `LOCALAPPDATA` / `ProgramFiles` 等）；
路径判定**解析真实路径**（项目里的符号链接指向外面会被拒）；超时用 `taskkill /T /F`
收整棵进程树，输出上限是 stdout + stderr **合计** 4000 字符。

### 诚实说边界

这是 L1：防的是「手滑 + 模型乱来 + 事后可查」，**不是防恶意**。

- 信任一个命令 = 放开那个命令的全部能力。信任了 `node`，`node -e "…"` 就能读写任意文件、绕过网关的 `fs.write`
- 被信任的命令能 `cat .env` 文件本身（env 清理堵的是「继承」，不是「读取」）
- 所有检查都在同一个进程、同一个用户、同一份文件系统权限里，挡不住「agent 自己写脚本绕过」
- 每一次放行与拒绝都落账（`tag='policy'`，`/policy log` 可查），但仅此而已

真正的隔离（容器 / 微虚拟机）在产品化清单上。

---

## MCP：接外部工具

在 `hive.config.json`（可用 `HIVE_CONFIG` 换路径）里声明 stdio server：

```json
{
  "mcp": {
    "servers": {
      "echo": { "command": "node", "args": ["--import", "tsx", "server.ts"], "cwd": "." }
    },
    "agents": ["A"],
    "allowServers": ["echo"]
  }
}
```

- 启动时一次性 `listTools()` 并**冻结清单**：运行中不热插拔 —— 工具 schema 变了、
  前缀缓存却不知道，那是最贵的一种错。改配置 → 重启。
- 工具名 `mcp__<server>__<tool>`；`/mcp` 看连接状态与工具数。
- **装了 ≠ 准调**：`mcp.allowServers` 为空时全部拒绝；`.hive/policy.json` 里
  `agents.X.mcp = "deny"` 可以再收紧（身份 deny 优先于 server 白名单）。
- 连不上的 server 只报一条警告，不影响 hive 启动。

## skill：装载方法论文本

`hive.config.json` 里指定目录（默认 `.hive/skills`），启动时把这一层的 `*.md` 读进内存并冻结：

```json
{
  "skills": { "dir": ".hive/skills", "agents": ["A"] }
}
```

- 文件名（去 `.md`）= skill 名；第一条 `# ` 行 = 标题；单个文件默认 ≤ 64KB
  （`HIVE_SKILL_MAX_BYTES`）
- 两个装载入口：模型调 `load_skill({name})`，或人敲 `/skill load <name>`；`/skill list` 看清单，
  `/skill off` 卸载
- **贴在用户消息末尾，不另起一条**：它不进 system 前缀（否则一次装载 = 全盘缓存作废），
  也不进 checkpoint（`/history` 里看不到全文）。与角色片同侧，边际成本 ≈ 0
- 只接受冻结清单里的名字，不做路径拼接 —— 不存在任意读取；清单启动时冻结，改文件要重启
- `skills.agents` 之外的身份不装这件工具；没配 `skills.dir` 时 0 个工具、0 token

继续往下看之前先记住这条：**skill 是方法论，不是权限**。它能改模型的做事方式，
不能让它多读一个文件。

## web：取网页（域名白名单）

`hive.config.json` 里配白名单与装它的身份；没写这一段 = 0 工具 = 0 token：

```json
{
  "web": {
    "allowDomains": ["example.com", "*.wikipedia.org"],
    "agents": ["A"]
  }
}
```

- 白名单并入 policy 的 `net.allowDomains`；`HIVE_POLICY_NET` 设了就以环境变量为准。
  `*.example.com` 匹配裸域与任意子域，`*` = 不限（自担风险）
- 工具只做 GET、只走 http/https 默认端口、不带 userinfo；**域名解析到内网/回环地址直接拒绝**
- 重定向最多 5 跳，**每一跳重新过白名单 + 私网检查**；跨域跳转不豁免
- 只读 `text/*`、JSON、XML；其它类型只回元信息。字节上限 `HIVE_WEB_MAX_BYTES`（默认 2MiB），
  超时 `HIVE_WEB_TIMEOUT_MS`（默认 15s）
- 网关判定是 `net` 动作、target 是 hostname：`/policy log` 能看到每次 allow / deny

不做 POST、认证头、Cookie、浏览器渲染、HTML 转 Markdown —— 那些交给 MCP server。

## 子任务反问：`ask_parent`

B/C/D 在子任务里信息不够时，可以调 `ask_parent({question})` 把问题交回父会话：

- 本轮**暂停**（不再让模型继续，避免自问自答），问题随 `HandoffResult.question` 回到父层
- 父模型看到 `[B·t003-abcd 暂停] 子任务需要你回答：…` 后，用
  `delegate(resume="t003-abcd", goal="<回答>", budgetTokens=…)` 继续同一个子会话
- 是**暂停-续跑**，不是并发回调：父模型不必在子任务运行中待命（那会死锁），
  子任务让出控制权、拿到补充信息后再继续
- A 没有父，不装这件工具；独立会话（`hive --as B`）调它会被拒
- 设计见 `docs/V3-M3.5-DESIGN.md`

## 性能：把往返时间压到最低

- **批内并行**：模型一次返回多个工具调用时，只读的（`read_file` / `grep` / `glob` /
  `calculator` / `web_fetch`、MCP 只读工具、互不依赖的 `delegate`）会**并发执行**；
  写操作（`write_file` / `edit_file` / `bash`）与顺序敏感工具（`load_skill` /
  `ask_parent`）保持串行 —— 写后读不会被抢跑，写是一道屏障。
- **子任务并行**：一次给多个 `delegate`（或 `parallel`），子任务同时跑；
  各自独立 thread、独立预算、独立账本行。
- **MCP 并行连接**：启动时各 server 同时握手，启动时间取最大值而不是求和。
- 三个可调旋钮：`mcp.agents`（只给 A 装 MCP，前缀从 1.6 万字符降下来）、
  模块的 `think` 档（B/D 默认 `high`，可按任务降）、`HIVE_TOOL_STEPS`（批数上限）。
- 设计见 `docs/V4-PERF-DESIGN.md`。

## 隐私模式：只有物理屏幕能看到对话

启动 hive 时先选一次：

```
  启动方式
    1) 正常终端
    2) 隐私窗口 —— 防录屏（OBS / 腾讯会议共享看不到内容），功能与正常终端完全一致

  选择 [1/2]：
```

选 2 之后，hive 会自建一个窗口并对它调用 `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`：
OBS、录屏软件、腾讯会议共享拿到的是一块黑色，而**窗口里跑的是完整的 hive 终端**
（xterm + ConPTY）—— 斜杠命令、工具输出、流式回复和正常终端一模一样。

- **必须输入 1 或 2**。直接回车不会默认进入任何一边，这是刻意做的。
- 非交互场景（脚本、管道、`HIVE_NO_ASK=1`）不问，直接走正常终端 —— 自动化不能被一次提问改变。
- 快捷键：`Ctrl+Alt+P` 显示/隐藏，`Ctrl+Alt+R` 重启终端，`Ctrl+Alt+Q` 退出。
- 窗口是**后台进程**：不在任务栏、不在 Alt+Tab 里，关掉启动它的终端后仍然在跑，只能靠快捷键召唤。
- 稳定性：WDA 每 3 秒自检并在显示器/系统设置变化后重设；终端异常退出按 800ms / 2.5s / 6s
  退避重启（正常退出不重启）；WebView2 渲染进程崩溃后自动重建。
- 窗口里那一份 hive 带 `--privacy-child`：跳过启动菜单，并且账本正文列写 `[privacy]`。

**其它入口**

- `hive privacy`：跳过菜单直接进隐私窗口。
- `hive privacy --classic`：回退到旧的自绘聊天窗（只有对话，看不到工具输出），保留给排查用。
- Windows 双击 `hive.cmd`：和 `hive` 等价，会先确保 `dist/` 已构建。

**边界**

- **终端窗口本身保护不了**：`SetWindowDisplayAffinity` 只能作用于**调用进程自己的窗口**，
  对 Windows Terminal 的窗口从外部调用会返回失败（实测）。所以 hive 自己开窗口。
- 隐私模式下对话不会出现在启动它的那个终端里，也不写 `.hive/privacy/transcript.txt`
  （那是 classic 模式的文件桥接）；账本只记 token 用量。
- 不防：手机拍摄、HDMI 采集卡。
- 实现见 `privacy-window/`（`window.ps1` + `pty_bridge.py` + xterm.js）与
  `docs/PRIVACY-DESIGN.md`。

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

## 命令（29 个）

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
| `/delegate <身份> <目标>` ／ `/delegate --continue <taskId> <追加>` | 交办一次 / 续跑同一子会话（taskId 见 `/handoffs`）；模型调工具时还支持 `parallel` 并发 |
| `/tasks [n]` | 本次进程的子任务：运行中/完成/熔断/拒绝、预算与耗时（历史看 `/handoffs`） |
| `/mcp` | MCP server 与工具清单（启动时冻结；改配置后重启生效） |
| `/skill [list\|load <name>\|off]` | skill 清单 / 装载 / 卸载（文本贴用户消息末尾，不进前缀、不进 checkpoint） |
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
| `HIVE_CONFIG` | `hive.config.json` | MCP / 价格配置文件 |
| `DEEPSEEK_BASE_URL` | — | 自定义 DeepSeek 兼容端点（不设走官方） |
| `HIVE_PRICE_JSON` | — | 覆盖内置价表（JSON；写坏退回内置价） |
| `HIVE_POLICY_MCP` | — | MCP server 白名单（逗号分隔；优先于配置文件） |
| `HIVE_SKILL_MAX_BYTES` | `65536` | 单个 skill 文件的上限；超限跳过并警告 |
| `HIVE_WEB_MAX_BYTES` | `2097152` | `web_fetch` 单次响应字节上限；超限截断并标注 |
| `HIVE_WEB_TIMEOUT_MS` | `15000` | `web_fetch` 超时（整条重定向链共用一个） |
| `HIVE_WEB_MAX_REDIRECTS` | `5` | `web_fetch` 最多跟随几跳；每一跳重新过白名单 |
| `HIVE_DEBUG` | 空 | `1` 时输出 model/tool/mcp/ledger 调试日志到 stderr |

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

提交前建议 `npm ci && npm run typecheck && npm test`。贡献约定与「加一个 capability」的步骤见
[`CONTRIBUTING.md`](CONTRIBUTING.md)，版本变更见 [`CHANGELOG.md`](CHANGELOG.md)。

测试全部零 API（假模型 / 临时目录 / 纯函数），所以改代码不必花一分钱。

## 仓库里还有什么

`hive` 本体是 `src/` + `privacy-window/`，也是 npm 包发出去的全部内容
（见 `package.json` 的 `files`）。仓库根目录另外放了几个**配套件**，它们不随包安装，
clone 下来才有：

| 路径 | 是什么 | 依赖 |
|---|---|---|
| `llm-failover/` | 断网回退代理：云端优先，连不上/超时/5xx/429 时自动改发本地 Ollama，网络恢复后自动切回。对客户端透明，只需把 `base_url` 指向 `http://127.0.0.1:11500` | Python 3 + 本地 `ollama` |
| `ctf-workspace/` | CTF 解题工作区：解题铁律（禁止一句话结论、必须给可复现过程）+ 本地模型启动脚本 | `ollama` |
| `start-all.bat` | 一键起 Ollama + 回退代理，并打印两边状态 | 上面两个 |
| `agent.py` | 学习计划里的账本/几何律核查脚本（`Meter`、`/misscheck` 那一套的 Python 版），用来在真实数据上验证「未命中 = (入 mod 64) + 64k」 | langgraph / langchain-core / langchain-deepseek |
| `smoke_test.py` | 最小冒烟：确认 langgraph 链路能通 | 同上 |

这几个脚本里的路径都走环境变量或相对自身目录（`OLLAMA_HOME` / `OLLAMA_MODELS` /
`DEEPSEEK_API_KEY`），没有写死任何机器上的位置。`llm-failover/README.md` 里有完整的
切换条件、双档模型分流和回滚步骤。

## 路线图

- [x] v0.1 缓存友好前缀 + 尾部角色槽位 + token 账本 + 几何律检验
- [x] v2 多 agent：令牌、结构化交接、模块栈、预算闸门、思考分级
- [x] v3 M1 agent 一等公民：`hive --as`、独立可续会话
- [x] v3 M2 capability 层 + 能力网关（L1 policy）+ 判罚落账
- [x] v3 M2.5 实用化四件：`edit_file`、循环护栏、上下文压缩、`bash`
- [x] v3 M2.6 沙箱加固：子进程 env 最小化、路径解析真实路径
- [x] v3 M3.1 子会话可续（父驱动往返）+ 按 agent 核账（`/ledger agents`）
- [x] v4 M4.1 协调：并行借调（`parallel`）+ 每 run 独立 runtime + `/tasks`
- [x] v4 M4.2a 扩展：MCP（stdio + 动态工具 + policy）+ DeepSeek 配置化
- [x] v4 M4.3 可工作：Ctrl+C 只停当前轮、错误分类、`hive init`、busy_timeout、`HIVE_DEBUG`
- [x] v4 M4.2b 扩展：`skill` 装载（`skills.dir` + `load_skill` + `/skill`，贴尾不进前缀/checkpoint）
- [x] v4 M4.2b 剩余：`web_fetch`（域名白名单 + 私网拦截 + 字节上限，默认不装）
- [x] 隐私模式：`hive privacy` 自建 WDA 窗口，对话对录屏不可见（Windows）
- [x] 隐私模式 v4.6：窗口后台化（不进任务栏 / Alt+Tab、关终端仍在）+ 稳定性（WDA 自检、终端自动重启、WebView2 重建、日志轮转）
- [x] v3 M3.5：B 主动反问 A（`ask_parent` + 暂停-续跑）
- [x] v4 M4.4 发布工程：三平台 CI、CHANGELOG、CONTRIBUTING
- [ ] 推到 npm registry（本地已有可用包，等有 OTP 时补）
- [ ] 以后：容器级隔离

设计与实测记录都在 `docs/` 里（V2-PLAN、V3-PLAN、V3-M2-DESIGN、V3-M2.5-DESIGN、V3-M2.6-DESIGN、V3-M3-DESIGN、V3-M3.5-DESIGN、V4-PLAN、V4-M4.2B-DESIGN、V4-M4.2B-WEB-DESIGN、V4-PERF-DESIGN、PRIVACY-DESIGN）。

## License

[MIT](LICENSE) © 2026 dez-eng
