/**
 * shell capability 的工具 —— **不给 shell**（v3 M2.5，docs/V3-M2.5-DESIGN.md §4）。
 *
 * 用 `spawn(bin, args)` 直接执行，**绝不用 `sh -c`**：走 shell 的话白名单形同虚设
 * （`ls; rm -rf /` 的第一个词是 `ls` 就放行了）。代价要认：管道 `|`、重定向 `>`、
 * 通配符 `*`、`&&` 全都不支持。
 *
 * ⚠ 诚实边界（写在这里，别假装没有）：
 *   · 白名单是「信任这个命令」，**不是**「限制它的作用范围」—— `ls` 一旦被信任
 *     就能列任意目录，`roots` 对 exec 没有意义
 *   · 子进程能直接写文件，**绕过网关的 fs.write**（网关只管工具调用）
 *   · 命令能读到进程环境（`env` 这类会吐出来）
 * 真正的隔离是 M3 的 L2（子进程 + env 清理 + cwd 锁定）。所以默认白名单是**空**的。
 */
import { spawn } from 'node:child_process';

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { commandAllowed, currentSpec, rootsReal, splitCommand } from './policy.js';

// 命令解析与白名单判定住在 policy.ts（网关与工具层共用一份语义），这里只做转发
export { commandBase, commandAllowed, splitCommand } from './policy.js';

export const BASH_TIMEOUT_MS = 10_000;
export const BASH_TIMEOUT_MAX_MS = 30_000;
/** 输出上限（stdout + stderr 合计）—— 工具结果是必然未命中的全价 token */
export const BASH_OUTPUT_MAX = 4000;

export interface BashResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * v3 M2.6：子进程的**最小环境**。
 *
 * 起因很直接：`spawn` 不传 `env` 就是继承整个 `process.env`，而 `cli.ts` 用
 * `loadEnvFile()` 把 `.env` 读进来了 —— 于是任何被放行的命令只要 `env` 一下，
 * `DEEPSEEK_API_KEY` 就被打印出来了。那是我们主动把钥匙递过去。
 *
 * 这**不**阻止被信任的命令去读它本来就有权读的文件（`.env` 文件还在磁盘上）——
 * 它堵的是「继承」这一条。真正的隔离是 L3。
 */
export const BASH_ENV_KEEP = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'LANG',
  'LC_ALL',
  'TZ',
  'SHELL',
  'USER',
];

/** 双保险：名字里带这些词的一律不给 —— 逃生舱也过不了这一层（刻意的） */
export const BASH_ENV_DENY = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** 逃生舱：`HIVE_BASH_ENV_KEEP=GOPATH,JAVA_HOME`（显式列出才透传，且仍过敏感词过滤） */
export function envKeepList(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env['HIVE_BASH_ENV_KEEP'] ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function childEnv(
  env: NodeJS.ProcessEnv = process.env,
  extra: string[] = envKeepList(env),
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [...BASH_ENV_KEEP, ...extra]) {
    if (BASH_ENV_DENY.test(name)) continue;
    const v = env[name];
    if (typeof v === 'string') out[name] = v;
  }
  return out;
}

/** 跑一条命令。超时用 SIGKILL 杀，输出按上限截断 —— 绝不让一次调用把进程拖死 */
export function runCommand(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<BashResult> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        // v3 M2.6：显式给一份最小环境，不再继承整份 process.env
        env: opts.env ?? childEnv(),
      });
    } catch (e) {
      done({
        code: null,
        stdout: '',
        stderr: e instanceof Error ? e.message : String(e),
        timedOut: false,
        truncated: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (r: BashResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };

    const collect = (which: 'out' | 'err', chunk: string): void => {
      // 按「剩余空间」切片：chunk 可能一次就来几十 KB，不能指望下次再判
      const cur = which === 'out' ? stdout : stderr;
      const room = BASH_OUTPUT_MAX - cur.length;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const piece = chunk.length > room ? chunk.slice(0, room) : chunk;
      if (piece.length < chunk.length) truncated = true;
      if (which === 'out') stdout += piece;
      else stderr += piece;
    };

    child.stdout?.on('data', (d: unknown) => collect('out', String(d)));
    child.stderr?.on('data', (d: unknown) => collect('err', String(d)));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出了 */
      }
      finish({ code: null, stdout, stderr, timedOut, truncated });
    }, opts.timeoutMs);

    child.on('error', (e: Error) => {
      finish({ code: null, stdout, stderr: `${stderr}${e.message}`, timedOut, truncated });
    });
    child.on('close', (code: number | null) => {
      finish({ code, stdout, stderr, timedOut, truncated });
    });
  });
}

export const bashTool = tool(
  async ({ command, timeout_ms }: { command: string; timeout_ms?: number }): Promise<string> => {
    const cmd = (command ?? '').trim();
    if (!cmd) return 'ERROR: command 不能为空';

    // 工具层兜底（真正的判定在网关；这里保证「无论谁调都不会跑白名单外的命令」）
    const { ok, base } = commandAllowed(cmd, currentSpec().exec.allowCommands);
    if (!ok) {
      return `ERROR: 命令 ${base} 不在 exec.allowCommands 里（.hive/policy.json 加 "${base}"，或写 "*" 表示不限）`;
    }

    const { bin, args } = splitCommand(cmd);
    if (!bin) return 'ERROR: 解析不出命令名';

    const asked = Math.trunc(timeout_ms ?? BASH_TIMEOUT_MS);
    const timeoutMs = Math.min(Math.max(asked, 100), BASH_TIMEOUT_MAX_MS);
    // cwd 也走真实路径：roots 本身可能是链接
    const cwd = rootsReal()[0] ?? process.cwd();

    const r = await runCommand(bin, args, { cwd, timeoutMs, env: childEnv() });

    const parts: string[] = [];
    if (r.stdout) parts.push(r.stdout.trimEnd());
    if (r.stderr) parts.push(`[stderr] ${r.stderr.trimEnd()}`);
    if (r.timedOut) parts.push(`[超时 ${timeoutMs}ms，已杀掉]`);
    if (r.truncated) parts.push(`[输出超 ${BASH_OUTPUT_MAX} 字符，已截断]`);
    parts.push(`[退出码 ${r.code === null ? '—（被信号杀掉或无此命令）' : r.code}]`);

    return parts.join('\n').slice(0, BASH_OUTPUT_MAX + 200);
  },
  {
    name: 'bash',
    description: '跑一条命令（没 shell 所以不支持管道/重定向；命令要在策略白名单里）。',
    schema: z.object({
      command: z.string().describe('例如 git status'),
      timeout_ms: z.number().int().positive().optional().describe('超时毫秒，默认 10000'),
    }),
  },
);
