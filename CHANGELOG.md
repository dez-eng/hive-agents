# Changelog

所有值得注意的变更都记在这里。格式基于
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [4.7.0] - 2026-11-12

### Changed

- **隐私窗口界面改成极简对话风（纯视觉，行为零改动）**：`privacy-window/terminal.html`
  整份重写，从「GitHub 深色 + 蓝/绿/紫黄四种强调色」换成暖中性底 + **单一陶土橙**强调，
  居中 760px 窄栏、serif 标题、胶囊化的思考/工具条、卡片式输入框、底部指标栏降到 11.5px
  的弱重量。一屏只让一个颜色说话，其余全退后 —— 原来四色并列时视线是散的。
  内置明暗两套主题（`data-theme`，默认暖暗，按钮切换，选择存 `localStorage`），
  切主题时页面多发一条 `{type:'theme',dark:0|1}`，`window.ps1` 用
  `DwmSetWindowAttribute`（20 / 19 兼容 Win10，35/36/34 给 Win11）把**系统标题栏**
  一起换色，否则暗色正文顶着一条白标题栏像两个程序拼的。
  `window.ps1` 里 4 处硬编码的冷黑 `#0b0b0c`（窗体背景、WebView2 默认背景 ×2、
  启动失败提示）统一改成 `#1f1e1d`，加载与崩溃重建时不再闪一块不匹配的黑。
  消息契约、PTY 尺寸（120×40）、热键、WDA、事件流全部原样；思考条只在 `think_end`
  后显示「8s」耗时，拿到中文备注时换成备注、耗时留在右侧。

### Added

- **配套工具入库（不随 npm 包发布，clone 才有）**：仓库根目录新增
  `llm-failover/`（断网回退代理：云端优先，连接失败/超时/5xx/429 时自动改发本地
  Ollama，探测到云端恢复即切回，对客户端透明；双档分流 —— 带 `tools` 的请求走
  `qwen3:8b` 并关思考，纯问答走 `qwen3:30b-a3b-thinking-2507` 保留思维链）、
  `ctf-workspace/`（解题铁律 + 本地模型启动脚本）、`start-all.bat`（一键起两端并
  打印状态）、`agent.py` / `smoke_test.py`（账本与几何律核查、链路冒烟）。
  入库前把所有 `D:\langchain` / `C:\Users\…` 硬编码路径改成 `%~dp0` 相对自身目录
  与 `OLLAMA_HOME` / `OLLAMA_MODELS` / `DEEPSEEK_API_KEY` 环境变量，别人 clone
  下来即可运行；`llm-failover/*.log`、`*.tgz`、`__pycache__/` 已加入 `.gitignore`。

- **v4.7（隐私窗口：左交互 / 右思考 / 底栏指标）**：窗口从「一整块终端」改成三栏 ——
  左侧仍是完整 hive 终端（斜杠命令、工具输出、中断全部原样），右侧新增**思考栏**，
  底部一行指标栏。数据不走终端流，而是 node 侧另写一份 JSONL 事件
  （`.hive/privacy/ui-events.jsonl`，`--ui-events=<path>`），由 `window.ps1` 每 150ms
  读增量、`PostWebMessage` 推给前端 —— 解析 ANSI 猜样式那套太脆，一换配色就崩。
  右栏每段思考结束再调一次 flash 生成**一句中文备注**（英文思考人看不懂；约 1s、
  成本可忽略，`HIVE_UI_GIST=0` 可关，失败退规则版），并可折叠查看思考原文。
  思考档：隐私窗口里把 `low` 身份提升为 `high`（`effectiveThink`）—— 实测主控默认
  关思考，不提升则右栏全空；正常终端保持原档，思考 token 那 30% 不该悄悄涨价。
  底栏含模型 / 峰谷 / 本轮花费与思考占比 / 上下文 / 本次缓存命中数与命中率 /
  会话累计与平均每轮 / 账户余额（`/user/balance`，60s 缓存）。
  踩到的坑记在这里：**LangGraph 的 `streamMode:'messages'` 会把
  `additional_kwargs.reasoning_content` 冲成 null**（裸 `ChatDeepSeek.stream` 里
  明明是逐块中文增量），所以思考正文只能从 `handleLLMEnd` 的合并消息里取；
  另外 `baseUrl()` 未设置时返回的是空串而非 undefined，`??` 兜不住，拼出
  `/user/balance` 直接 ERR_INVALID_URL。

- **v4.7 续（普通模式也用同一套窗口界面）**：启动菜单从两项变三项 ——
  1) 窗口界面（对话流 + 思考 + 指标栏，**不防录屏**） 2) 隐私窗口（同上界面 + WDA
  防录屏 + 账本脱敏） 3) 纯终端（脚本 / SSH / 窗口起不来时）。`hive window` 与
  `hive privacy` 可直达，不必过菜单。
  「在窗口里跑」与「隐私脱敏」拆成两个独立开关：`--privacy-child` 只表示「我是窗口里
  那一份」（跳菜单、发事件、开思考），脱敏另走 `--redact` —— 否则普通窗口里
  `/cost`、`/sessions` 全是 `[privacy]`，正常用反而更难受。
  `noProtect` 走 `window.json` 而不是环境变量：窗口进程由 WMI `Win32_Process.Create`
  创建，**不继承调用者的环境**，环境变量传不进去（实测踩过）。
  普通窗口起不来（非 Windows / `privacy-window/` 不完整 / 启动失败）自动回退纯终端
  并打印原因；隐私窗口仍然报错 —— 它静默降级成一个会被录进去的终端才是真问题。
  顺带修掉一处空花销：没有事件通道时不再调用备注生成（原先 `hive --as B` 这类
  high 档身份在终端里每段思考都会白调一次 flash，结果没人看）。
  实测两种窗口的差别：`hive window` → `excluded=False affinity=0x00`（无 `--redact`）；
  `hive privacy` → `excluded=True affinity=0x11`（带 `--redact`）。零 API 测试 284。

- **v4.6（隐私模式的后台化与稳定性）**：窗口改成**后台进程** ——
  `WS_EX_TOOLWINDOW` + `ShowInTaskbar=false`，任务栏和 Alt+Tab 里都没有它，只靠
  `Ctrl+Alt+P` 召唤；窗口进程改由 WMI `Win32_Process.Create` 创建，脱离启动器的
  Job Object，**关掉终端窗口后窗口继续跑**（`spawn(detached)` 做不到这一点），WMI 起不来
  才退回 `cmd /c start`。启动器轮询 `window.status` 确认窗口真的起来了（15s 上限），
  失败时返回原因与日志路径而不是「命令返回 0、窗口不见」。稳定性方面：WDA 每 3s 校验
  并在显示器/系统设置变化后重设（实测会掉到 `0x00` 再被恢复）、终端进程异常退出按
  800ms/2.5s/6s 退避自动重启（正常退出不重启）、WebView2 渲染进程崩溃后重建控件、
  关窗时先关 stdin 优雅收掉 ConPTY 再 `taskkill /T /F` 兜底、bridge 每 2s 检查父进程
  防止变孤儿、启动前预检 `pywinpty`、两侧日志都加了大小轮转。新增热键 `Ctrl+Alt+R`
  重启终端。零 API 测试 251 → 259。设计见 `docs/PRIVACY-DESIGN.md` §0.1 / §0.2。

- **v4.5（隐私模式 TUI）：启动菜单强制选择，窗口里就是完整 hive**。
  `hive` 启动时问 `1) 正常终端 / 2) 隐私窗口`，**必须输入 1 或 2**（回车不再默认进正常模式）；
  脚本 / 管道 / `HIVE_NO_ASK=1` 仍然不问。选 2 后不再打开旧的自绘聊天窗，而是把
  **完整的 hive 终端**搬进防录屏窗口：`privacy-window/window.ps1`（WinForms + WDA +
  WebView2）→ `pty_bridge.py`（ConPTY）→ `node dist/cli.js --privacy-child`，xterm.js 渲染，
  斜杠命令 / 工具输出 / 流式回复与正常终端一致。`--privacy-child` 跳过菜单并把账本正文
  写成 `[privacy]`。旧的聊天窗保留为 `hive privacy --classic`。新增 `hive.cmd` 双击入口
  （自动确保 `dist/` 已构建）。窗口侧新增 `privacy-launch.log` 与 `pty-bridge.log`。

- **v4 M4.2b（skill 装载）**：`hive.config.json` 的 `skills.dir`（默认 `.hive/skills`）
  启动时读入这一层 `*.md` 并冻结清单；`load_skill` 工具（按 `skills.agents` 装配）
  + `/skill list|load|off` 命令；文本只贴**发送视图**里最后一条 HumanMessage，
  不进 system 前缀、不进 checkpoint；单个文件上限 `HIVE_SKILL_MAX_BYTES`（默认 64KB）。
  `hive init` 多生成 `.hive/skills/example.md`。零 API 测试 205 → 215。
  设计见 `docs/V4-M4.2B-DESIGN.md`。

- **v4 M4.2b 剩余（web fetch）**：`hive.config.json` 的 `web.allowDomains`
  （精确 / `*.` 子域 / `*`）并入 policy 的 `net.allowDomains`，`web.agents`
  决定哪些身份装 `web_fetch`；没配 `web` 段 = 0 工具 = 0 token。工具只 GET、
  只默认端口、拒 IP 字面量与私网解析（DNS 全地址检查）、重定向逐跳重新校验、
  只读文本类型，字节 / 超时 / 跳数都有上限。`hive init` 模板补 web 段。
  零 API 测试 215 → 232。设计见 `docs/V4-M4.2B-WEB-DESIGN.md`。

- **v3 M3.5（B 主动反问 A）**：B/C/D 在子任务里调 `ask_parent({question})`，
  本轮暂停（不再让模型自问自答），问题随 `HandoffResult.question` 回到父层；
  父用 `delegate(resume=…, goal=回答)` 继续同一个子 thread。A 没有父、不装这件；
  独立会话调用被拒；问题截到 2000 字符。`ask` 能力追加在 `CAPABILITY_ORDER`
  末尾，不改变前面字节。零 API 测试 232 → 240。设计见 `docs/V3-M3.5-DESIGN.md`。

- **v4 性能（批内并行）**：同一批 `tool_calls` 里只读工具（`read_file` / `grep` /
  `glob` / `calculator` / `web_fetch`、MCP 只读工具、互不依赖的 `delegate`）并发执行；
  写操作与顺序敏感工具（`load_skill` / `ask_parent`）保持串行并作为屏障，结果按调用
  下标回填。`connectMcp` 改为并行连接各 server。`delegate` 描述引导模型把独立子任务
  放进同一批。零 API 测试 240 → 244。设计见 `docs/V4-PERF-DESIGN.md`。

- **隐私模式（Windows）**：`hive privacy` 把对话搬进自建 WinForms 窗口，窗口自己调用
  `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`，OBS / 录屏 / 会议共享看不到内容；
  终端只显示状态。窗口与主进程用 `.hive/privacy/` 下的 transcript/inbox/seq/closed
  四个文件桥接。终端窗口本身无法从外部保护（API 只允许本进程窗口），这是自建窗口的
  原因。零 API 测试 244 → 251。设计见 `docs/PRIVACY-DESIGN.md`。

### Fixed

- **v4.7（bash 在 Windows 上真正可用）**：`npm` / `npx` / `yarn` / `pnpm` 在 Windows 上
  实际是 `.cmd`，旧实现 `spawn(bin)` 不按 `PATHEXT` 解析，直接 `ENOENT`。现在先解析真实
  文件，`.cmd/.bat` 只经由 `cmd.exe /d /s /v:off /c` 启动，参数逐条加引号，拒绝 cmd 无法
  安全转义的 `"` / `%` / 换行；白名单仍按原始命令名判定（放行 `npm` 即可）。同时补全
  子进程的 Windows 环境（`APPDATA` / `LOCALAPPDATA` / `ProgramFiles` 等）、stdin 不再挂起、
  超时用 `taskkill /T /F` 收整棵进程树、输出上限恢复为 stdout+stderr 合计 4000。
  零 API 测试 259 → 265（新增 6）。管道 / 重定向 / 通配符仍不支持。

- **v4.7（从任意目录启动）**：`.env` 按「cwd → `~/.hive/.env` → 包根」三层回退，
  全局 `hive` 在用户目录里也能读到安装目录的 key；没有 key 时列出查过的路径并以
  退出码 2 退出，不再在 `buildContext` 里抛 `Deepseek API key not found` 的 stack。
  `--privacy-child` 现在真正跳过启动菜单（之前只设了环境变量，窗口里会再问一次），
  隐私窗口里的终端不会再启动即退出。零 API 测试 265 → 267。

### 计划

- 容器级隔离（L3）

## [0.1.0] - 2026-10-19

### Added

- **v0.1**：逐字节不变的 system 前缀、挂在用户消息末尾的角色片、token 账本、
  DeepSeek 缓存几何律检验
- **v2**：A/B/C/D 多 agent、授权令牌、结构化交接、模块栈、预算闸门、思考分级
- **v3 M1**：agent 一等公民 —— `hive --as` 独立启动、`solo#X` 可续会话
- **v3 M2**：capability 层（工具按身份装配）、能力网关、`.hive/policy.json`、判罚落账
- **v3 M2.5**：`edit_file`、工具批数护栏、上下文压缩、`bash`（无 shell + 白名单）
- **v3 M2.6**：子进程 env 最小化、路径解析 realpath
- **v3 M3.1**：子会话可续（`delegate(resume=…)`）、按 agent 核账（`/ledger agents`）
- **v4 M4.1**：并行借调（`delegate(parallel=[…])`）、每 run 独立 runtime
  （AsyncLocalStorage）、令牌预算原子预留/结算、`/tasks`
- **v4 M4.2a**：MCP stdio client（`hive.config.json`、`mcp__server__tool`、
  `mcp.allowServers`、`/mcp`）、`DEEPSEEK_BASE_URL`、`HIVE_PRICE_JSON`
- **v4 M4.3**：Ctrl+C 只中止当前轮、错误分类、`hive init`、SQLite `busy_timeout`、
  `HIVE_DEBUG`
- 27 个 REPL 命令；8 个内置工具；205 个零 API 测试

### Fixed

- `glob` 的 pattern 被能力网关当成路径做 realpath 检查，导致
  `src/**/*.ts` 被误判越界
- MCP 工具动态注册后 `TOOL_MAP` / `ALL_TOOLS` 未同步，执行层报「没有这个工具」
