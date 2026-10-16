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

import { commandBase, currentSpec, rootsOf } from './policy.js';

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
 * 把命令行切成 `[bin, ...args]`。支持单双引号（引号内不被空格切开），
 * 不支持转义、变量展开、管道、重定向 —— 那些都需要 shell，而我们不给 shell。
 */
export function splitCommand(command: string): { bin: string; args: string[] } {
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || cur) {
        parts.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur) parts.push(cur);

  const [bin = '', ...args] = parts;
  return { bin, args };
}

/** 白名单判定：`"*"` 表示不限（自担风险），否则按命令 basename 精确比对 */
export function commandAllowed(
  command: string,
  allow: string[],
): { ok: boolean; base: string } {
  const base = commandBase(command);
  return { ok: allow.includes('*') || allow.includes(base), base };
}

/** 跑一条命令。超时用 SIGKILL 杀，输出按上限截断 —— 绝不让一次调用把进程拖死 */
export function runCommand(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<BashResult> {
  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { cwd: opts.cwd, shell: false, windowsHide: true });
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
    const cwd = rootsOf()[0] ?? process.cwd();

    const r = await runCommand(bin, args, { cwd, timeoutMs });

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
