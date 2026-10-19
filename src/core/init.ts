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
    price: {},
  },
  null,
  2,
)}\n`;

export function initFiles(dir = process.cwd(), opts: { force?: boolean } = {}): InitResult {
  const files: InitFile[] = [
    { path: '.env.example', content: ENV_EXAMPLE },
    { path: '.hive/policy.json', content: POLICY_EXAMPLE },
    { path: 'hive.config.example.json', content: CONFIG_EXAMPLE },
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
