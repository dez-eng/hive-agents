# Changelog

所有值得注意的变更都记在这里。格式基于
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

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
