# Changelog

所有值得注意的变更都记在这里。格式基于
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划

- v4 M4.2b：`skill` 装载、`web` fetch（域名白名单）
- v3 M3.5：B 主动反问 A、`@` 寻址
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
