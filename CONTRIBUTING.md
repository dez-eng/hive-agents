# Contributing

## 环境

- Node **≥ 22.5**（用到内置 `node:sqlite` 与 `process.loadEnvFile`）
- 不需要 API key 也能跑全部测试：测试全部是零 API 的（假模型 / 临时目录 / 纯函数）

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## 改动前必读：四条设计约束

1. **`STABLE_PREFIX` 逐字节不变**（`src/core/prompt.ts`）—— 改一个字符就是一次全盘缓存作废。
2. **角色片挂在用户消息末尾** —— 不要把它挪进 system 前缀。
3. **权限收在执行层** —— 模型「答应不做」不算数，代码挡住才算数。
4. **工具 schema 按 agent 分套** —— `CAPABILITY_ORDER` 的顺序就是前缀顺序；
   新增 capability 请**追加在末尾**，并且只让需要它的 agent 装上。

## 加一个 capability

1. `src/core/modules.ts`：`CapabilityId` 加名字，必要时给 `AGENTS` 增能力。
2. `src/core/capability.ts`：在 `CAPABILITIES` 注册工具，`CAPABILITY_ORDER` 末尾追加；
   有副作用的工具在 `TOOL_ACTION` 里映射动作类型。
3. `src/core/policy.ts`：如需要新的动作类型，补 `ActionKind`、`DEFAULT_SPEC` 与判定。
4. 补零 API 测试：装配顺序、网关放行/拒绝、工具本身的行为。
5. 如果它改变前缀：在 PR 里明说「会作废哪些 agent 的缓存」。

## 提交与测试

- 提交信息用 `feat(...) / fix(...) / docs(...) / chore(...)`，正文写「为什么」。
- 新增行为必须有测试；测试不要真的调模型、不要写用户的账本。
- `npm test` 必须全绿；`npm run typecheck` 必须无错。
- 不要提交 `.env`、`*.db`、`dist/`、`node_modules/`。

## 发布

见 `CHANGELOG.md` 与仓库的 GitHub Actions（三平台 × Node 22/24）。
发布前在干净目录跑一次：

```bash
npm i -g hive-agents
hive init
hive doctor
hive run "3*7 等于几"
```
