# Changelog

所有值得注意的变更都记在这里。格式基于
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

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
