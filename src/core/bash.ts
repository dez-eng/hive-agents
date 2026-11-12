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
import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

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
  'SystemDrive',
  'windir',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  // Windows 上 npm / git / python 等会读这些；缺了不是「更安全」，而是直接坏掉
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'COMPUTERNAME',
  'USERNAME',
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

/**
 * Windows 上很多 CLI 是 `.cmd`（npm / npx / yarn / pnpm …）。`spawn(bin)` 不会按
 * PATHEXT 解析，直接 ENOENT；`shell: true` 又会把白名单打穿。这里自己做解析：
 * 在 PATH 里按 PATHEXT 找到真实文件，`.cmd/.bat` 只经由 cmd.exe 启动，参数逐条引号包裹。
 */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function windowsExts(env: NodeJS.ProcessEnv): string[] {
  return (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 找到一个命令的真实可执行文件；找不到返回 null。POSIX 上只认原样。 */
export function resolveExecutable(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  const hasDir = bin.includes('/') || bin.includes('\\') || isAbsolute(bin);
  const bases = hasDir
    ? [isAbsolute(bin) ? bin : resolve(cwd, bin)]
    : (env['PATH'] ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((d) => join(d, bin));

  for (const base of bases) {
    // Windows：先按 PATHEXT 试（npm -> npm.cmd），再认原样路径（命令行里写了完整 node.exe）
    if (platform === 'win32' && !/\.[a-z0-9]+$/i.test(base)) {
      for (const ext of windowsExts(env)) {
        if (isFile(base + ext)) return base + ext;
      }
    }
    if (isFile(base)) return base;
  }
  return null;
}

export type SpawnPlan =
  | { ok: true; command: string; args: string[]; resolved: string; viaCmd: boolean }
  | { ok: false; error: string };

/** 参数包进双引号；调用方已拒绝 `"` / `%` / 换行，所以不需要再做转义 */
function cmdQuote(arg: string): string {
  return `"${arg}"`;
}

/**
 * 把「用户写的命令」翻译成可 spawn 的调用。
 *
 * `.cmd/.bat` 只能由 cmd.exe 解释，因此这里是唯一会经过 shell 的路径 —— 边界收窄为：
 * 只执行解析出来的那个批处理文件，每个参数单独加引号，且拒绝 cmd 无法安全转义的
 * `"`、`%`、换行与 NUL。白名单仍按原始命令名判定（npm 放行 ≠ cmd 放行）。
 */
export function planCommand(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): SpawnPlan {
  const resolved = resolveExecutable(bin, env, cwd, platform);
  if (!resolved) {
    return { ok: false, error: `找不到命令 ${bin}（PATH 里没有可执行文件）` };
  }

  if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) {
    for (const a of args) {
      if (/["%\r\n\0]/.test(a)) {
        return { ok: false, error: `参数含 cmd 无法安全转义的字符（" % 换行）：${a}` };
      }
    }
    const comspec = env['COMSPEC'] || 'cmd.exe';
    const line = [resolved, ...args].map(cmdQuote).join(' ');
    return {
      ok: true,
      command: comspec,
      args: ['/d', '/s', '/v:off', '/c', `"${line}"`],
      resolved,
      viaCmd: true,
    };
  }

  return { ok: true, command: resolved, args, resolved, viaCmd: false };
}

/** 跑一条命令。超时用 SIGKILL 杀，输出按上限截断 —— 绝不让一次调用把进程拖死 */
export function runCommand(
  bin: string,
  args: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  },
): Promise<BashResult> {
  const env = opts.env ?? childEnv();
  const plan = planCommand(bin, args, env, opts.cwd, opts.platform ?? process.platform);
  if (!plan.ok) {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: plan.error,
      timedOut: false,
      truncated: false,
    });
  }

  return new Promise((done) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(plan.command, plan.args, {
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
        // 子进程不读 stdin：否则 cat / python 这类会一直等输入，直到超时
        stdio: ['ignore', 'pipe', 'pipe'],
        // 经 cmd.exe 时参数已经按 cmd 规则拼好，不能再让 Node 包一层引号
        windowsVerbatimArguments: plan.viaCmd,
        // v3 M2.6：显式给一份最小环境，不再继承整份 process.env
        env,
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
      // 按「剩余空间」切片：chunk 可能一次就来几十 KB，不能指望下次再判。
      // 上限是 stdout + stderr 合计 —— 两路各 4000 会把工具结果翻倍。
      const room = BASH_OUTPUT_MAX - stdout.length - stderr.length;
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
      killTree(child);
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

/**
 * 超时收尸：Windows 上必须连子进程树一起收 —— `npm` 会拉起 node，
 * 只 kill 父进程会留下后台任务，用户下一次跑同一条命令还会撞上它。
 */
function killTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32' && child.pid) {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      return;
    } catch {
      /* 退回到下面的 kill */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已经退出了 */
  }
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
    description:
      '跑一条命令（命令要在策略白名单里）。不经过 shell，所以管道/重定向/通配符不支持；Windows 上 npm/npx 等 .cmd 会自动经 cmd.exe 启动。',
    schema: z.object({
      command: z.string().describe('例如 git status'),
      timeout_ms: z.number().int().positive().optional().describe('超时毫秒，默认 10000'),
    }),
  },
);
