/**
 * search capability 的两个工具 —— grep / glob（docs/V3-M2-DESIGN.md §4）。
 *
 * 三条自律：
 *   1. **结果上限**：工具结果是必然未命中的全价 token，比 READ_LIMIT 更要紧。
 *   2. **只在自己能看的地方走**：roots + ignore，越界直接拒（工具层兜底，
 *      真正的判定在网关 —— 见 policy.ts）。
 *   3. **正则来自模型**：用 `vm.runInNewContext` 带 timeout 跑，防止灾难性回溯
 *      把进程钉死。逐行 `re.test` 一旦 ReDoS 就是死循环，中断不了。
 *
 * 不用外部 `rg`（本机没有，也不能假设用户有）；不用 `fs.globSync`
 * （Node 22 里还是 experimental，Windows 路径分隔符行为未定型）。
 */
import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { runInNewContext } from 'node:vm';

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { ignoreOf, loadPolicy, rootsOf, withinRootsReal } from './policy.js';

/** 上限 —— 见 §4.2 */
export const GREP_MAX_LINES = 40;
export const GREP_MAX_CHARS = 3000;
export const GLOB_MAX = 80;
export const FILE_MAX_BYTES = 64 * 1024;
export const FILES_MAX = 4000;
export const PER_FILE_MS = 200;
const MAX_DEPTH = 24;
const LINE_MAX = 200;

/** 相对 cwd 的正斜杠路径 —— 输出用（Windows 上也读得顺） */
function relPosix(p: string): string {
  return relative(process.cwd(), p).split(sep).join('/');
}

/** 遍历 roots 下的文件。**不跟符号链接**（`isFile()` 对链接为 false），不跟 ignore 目录 */
export function walkFiles(
  roots: string[],
  ignore: Set<string>,
): { files: string[]; stopped: boolean } {
  const files: string[] = [];
  let stopped = false;

  const walk = (dir: string, depth: number): void => {
    if (stopped || depth > MAX_DEPTH) return;
    let ents: Dirent<string>[];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (stopped) return;
      if (ignore.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (files.length >= FILES_MAX) {
        stopped = true;
        return;
      }
      files.push(p);
    }
  };

  for (const r of roots) {
    walk(r, 0);
    if (stopped) break;
  }
  return { files, stopped };
}

/**
 * 把 glob 模式编译成正则。
 * `**` 连斜杠 = 任意层；`**` 单独 = 任意字符；`*` = 一层内任意；`?` = 一层内一个字符。
 */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        i += 1;
        if (p[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('+.^$(){}|[]'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/** 在隔离上下文里跑正则，带软超时。返回命中行号，或错误 / 超时标记 */
export function matchLines(
  pattern: string,
  lines: string[],
): { hits: number[]; error?: string; timeout?: boolean } {
  const sandbox: { PATTERN: string; LINES: string[]; out: number[]; err: string } = {
    PATTERN: pattern,
    LINES: lines,
    out: [],
    err: '',
  };
  const code =
    'try { const re = new RegExp(PATTERN);' +
    ' for (let i = 0; i < LINES.length; i += 1) { if (re.test(LINES[i])) out.push(i); } }' +
    ' catch (e) { err = String((e && e.message) || e); }';
  try {
    runInNewContext(code, sandbox, { timeout: PER_FILE_MS });
  } catch {
    return { hits: [], timeout: true };
  }
  if (sandbox.err) return { hits: [], error: sandbox.err };
  return { hits: sandbox.out };
}

/** 限定搜索根：给了子路径就只走它，越界直接拒 */
function scopeRoots(sub?: string): string[] | string {
  const { spec } = loadPolicy();
  if (!sub || !sub.trim() || sub === '.' || sub === './') return rootsOf(spec);
  const target = resolve(process.cwd(), sub);
  if (!withinRootsReal(target, spec).ok) {
    return `ERROR: 越界，只能看 ${spec.roots.join(', ')} 之内（符号链接也算）`;
  }
  return [target];
}

export const grepTool = tool(
  async ({
    pattern,
    path,
    glob,
    maxResults,
  }: {
    pattern: string;
    path?: string;
    glob?: string;
    maxResults?: number;
  }): Promise<string> => {
    if (!pattern) return 'ERROR: pattern 不能为空';

    const scope = scopeRoots(path);
    if (typeof scope === 'string') return scope;

    let filter: RegExp | null = null;
    if (glob && glob.trim()) {
      try {
        filter = globToRegExp(glob.trim());
      } catch {
        return `ERROR: glob 写错了 ${glob}`;
      }
    }

    const cap = Math.min(Math.max(Math.trunc(maxResults ?? GREP_MAX_LINES), 1), GREP_MAX_LINES);
    const { files, stopped } = walkFiles(scope, ignoreOf());

    const rows: string[] = [];
    let chars = 0;
    let scanned = 0;
    let skippedBig = 0;
    let timeouts = 0;
    let truncated = false;
    let regexError: string | undefined;

    for (const f of files) {
      const rel = relPosix(f);
      if (filter && !filter.test(rel)) continue;

      let size = 0;
      try {
        size = statSync(f).size;
      } catch {
        continue;
      }
      if (size > FILE_MAX_BYTES) {
        skippedBig += 1;
        continue;
      }

      let text: string;
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue; // 二进制
      scanned += 1;

      const lines = text.split('\n');
      const res = matchLines(pattern, lines);
      if (res.error) {
        regexError = res.error;
        break;
      }
      if (res.timeout) {
        timeouts += 1;
        continue;
      }

      for (const idx of res.hits) {
        const body = (lines[idx] ?? '').trim().slice(0, LINE_MAX);
        const row = `${rel}:${idx + 1}: ${body}`;
        if (rows.length >= cap || chars + row.length > GREP_MAX_CHARS) {
          truncated = true;
          break;
        }
        rows.push(row);
        chars += row.length + 1;
      }
      if (truncated) break;
    }

    if (regexError) return `ERROR: 正则不合法 —— ${regexError}`;

    // 说明行（无匹配时也要给 —— 「为什么没搜到」比「没搜到」有用）
    const notes: string[] = [];
    if (stopped) notes.push(`已扫 ${scanned} 个文件后停（上限 ${FILES_MAX}）`);
    if (timeouts) notes.push(`${timeouts} 个文件正则超时被跳过`);
    if (skippedBig) notes.push(`${skippedBig} 个文件 >64KB 跳过`);

    if (!rows.length) {
      return (
        `（没有匹配 · 扫了 ${scanned} 个文件）` +
        (notes.length ? `\n（${notes.join(' · ')}）` : '')
      );
    }

    if (truncated) notes.unshift(`截断，只给前 ${rows.length} 行`);
    return rows.join('\n') + (notes.length ? `\n（${notes.join(' · ')}）` : '');
  },
  {
    name: 'grep',
    description: '按正则搜文件内容，返回 路径:行号: 内容。比通读文件省。',
    schema: z.object({
      pattern: z.string().describe('正则，例如 TODO|FIXME'),
      path: z.string().optional().describe('限定子树，默认全部'),
      glob: z.string().optional().describe('只搜匹配的文件名，如 **/*.ts'),
      maxResults: z.number().int().positive().optional().describe('最多几行，上限 40'),
    }),
  },
);

export const globTool = tool(
  async ({ pattern, maxResults }: { pattern: string; maxResults?: number }): Promise<string> => {
    if (!pattern || !pattern.trim()) return 'ERROR: pattern 不能为空';

    let re: RegExp;
    try {
      re = globToRegExp(pattern.trim());
    } catch {
      return `ERROR: glob 写错了 ${pattern}`;
    }

    const cap = Math.min(Math.max(Math.trunc(maxResults ?? GLOB_MAX), 1), GLOB_MAX);
    const roots = rootsOf(loadPolicy().spec);
    const { files, stopped } = walkFiles(roots, ignoreOf());

    const hits: string[] = [];
    for (const f of files) {
      const rel = relPosix(f);
      if (!re.test(rel)) continue;
      if (hits.length >= cap) break;
      hits.push(rel);
    }

    if (!hits.length) {
      return `（没有匹配 · 扫了 ${files.length} 个文件${stopped ? '（达到上限提前停）' : ''}）`;
    }
    const more = files.filter((f) => re.test(relPosix(f))).length;
    const notes: string[] = [];
    if (more > hits.length) notes.push(`共 ${more} 条，只给前 ${hits.length} 条`);
    if (stopped) notes.push(`已扫 ${files.length} 个文件后停（上限 ${FILES_MAX}）`);

    return hits.join('\n') + (notes.length ? `\n（${notes.join(' · ')}）` : '');
  },
  {
    name: 'glob',
    description: '按通配符列文件路径（** 递归、* 单层、? 一个字符）。',
    schema: z.object({
      pattern: z.string().describe('通配符，例如 src/**/*.ts'),
      maxResults: z.number().int().positive().optional().describe('最多几条，上限 80'),
    }),
  },
);
