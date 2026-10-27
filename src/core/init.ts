/**
 * `hive init`（v4 M4.3）：把「能跑起来」需要的文件一次生成。
 *
 * 三条自律：
 *   · **不覆盖**已有文件（除非 --force）—— init 是帮忙，不是重置
 *   · 只生成「模板」，不生成带真实 key 的 .env
 *   · policy 的模板与内置默认一致（default deny），使用者再按需放宽
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface InitFile {
  path: string;
  content: string;
}

export interface InitResult {
  written: string[];
  skipped: string[];
}

export const ENV_EXAMPLE = `# 必填：DeepSeek API Key
DEEPSEEK_API_KEY=sk-your-key

# 可选
# DEEPSEEK_MODEL=deepseek-flash
# DEEPSEEK_BASE_URL=
# HIVE_TURN_BUDGET=20000
# HIVE_TOOL_STEPS=16
`;

export const POLICY_EXAMPLE = `${JSON.stringify(
  {
    default: 'deny',
    roots: ['.'],
    agents: {
      A: { 'fs.read': 'allow', 'fs.write': 'allow' },
      B: { 'fs.read': 'allow', 'fs.write': 'deny' },
      C: { 'fs.read': 'allow', 'fs.write': 'allow' },
      D: { 'fs.read': 'allow', 'fs.write': 'deny' },
    },
    exec: { allowCommands: [] },
    net: { allowDomains: [] },
    mcp: { allowServers: [] },
    ignore: ['.git', 'node_modules', 'dist', '.hive'],
  },
  null,
  2,
)}\n`;

export const CONFIG_EXAMPLE = `${JSON.stringify(
  {
    mcp: {
      servers: {
        // 例：filesystem server（先安装再取消注释）
        // "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
      },
      agents: ['A'],
      allowServers: [],
    },
    skills: {
      dir: '.hive/skills',
      agents: ['A'],
    },
    web: {
      // 例：'example.com' / '*.wikipedia.org'；空数组 = 工具会装、调用全拒
      allowDomains: [],
      agents: ['A'],
    },
    price: {},
  },
  null,
  2,
)}\n`;

/** 示例 skill —— 同时演示格式与「贴尾」的用法；不装载就不产生任何 token */
export const SKILL_EXAMPLE = `# 示例 skill：代码复核

这是一个最小示例。用 \`/skill load example\` 装载后，这段文本会贴在本轮用户消息末尾；
它不进 system 前缀，也不进 checkpoint。

## 何时用

让模型按固定清单复核一份改动，而不是自由发挥。

## 步骤

1. 先读 diff，只看改动的行
2. 对每一处改动问：输入边界变了吗？错误路径变了吗？
3. 只报「有证据的问题」，每条带文件与行号
4. 没发现问题就说没发现
`;

export function initFiles(dir = process.cwd(), opts: { force?: boolean } = {}): InitResult {
  const files: InitFile[] = [
    { path: '.env.example', content: ENV_EXAMPLE },
    { path: '.hive/policy.json', content: POLICY_EXAMPLE },
    { path: 'hive.config.example.json', content: CONFIG_EXAMPLE },
    { path: '.hive/skills/example.md', content: SKILL_EXAMPLE },
  ];

  const written: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const abs = resolve(dir, f.path);
    if (existsSync(abs) && !opts.force) {
      skipped.push(f.path);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, 'utf8');
    written.push(f.path);
  }
  return { written, skipped };
}
