/**
 * 工具。描述已瘦身 —— 它每轮都在 prompt 里，多一个字就是每轮多一个字。
 * 工具 schema 属于冻结区的一部分，改描述同样会作废缓存。
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export const ROOT = resolve(process.cwd());

/**
 * 一次读取的上限。4,000 字符 ≈ 1,300 token，
 * 而工具结果必然是全价未命中 —— 这个数别放大。
 */
const READ_LIMIT = 4000;

export const calculator = tool(
  async ({ expression }: { expression: string }): Promise<string> => {
    const allowed = /^[0-9+\-*/%().\s]*$/;
    if (!allowed.test(expression)) return 'ERROR: 只允许数字和 + - * / % ( )';
    try {
      // 自己写解析，不用 eval —— 免得为了省事把口子开在这儿
      const value = safeEval(expression);
      if (value === null) return 'ERROR: 表达式不合法';
      return String(value);
    } catch (e) {
      return `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
  {
    name: 'calculator',
    description: '算数学表达式，只支持数字和 + - * / % ( )。',
    schema: z.object({ expression: z.string().describe('算式，例如 (1+2)*3') }),
  },
);

export const readFileTool = tool(
  async ({ path }: { path: string }): Promise<string> => {
    const target = resolve(ROOT, path);
    // 前缀比较要带分隔符，否则 D:\proj 会放行 D:\proj-evil
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      return 'ERROR: 越界，只能读项目目录内的文件';
    }
    try {
      if (!statSync(target).isFile()) return `ERROR: 不是文件 ${path}`;
      return readFileSync(target, 'utf8').slice(0, READ_LIMIT);
    } catch {
      return `ERROR: 读不到 ${path}`;
    }
  },
  {
    name: 'read_file',
    description: '读项目目录内的文件，path 用相对路径。',
    schema: z.object({ path: z.string().describe('相对路径，例如 src/index.ts') }),
  },
);

export const ALL_TOOLS = [calculator, readFileTool];

export const TOOL_MAP: Record<string, (typeof ALL_TOOLS)[number]> = Object.fromEntries(
  ALL_TOOLS.map((t) => [t.name, t]),
);

/** 工具定义在 prompt 里占多少字符 —— 它是冻结区的一部分 */
export function toolsChars(): number {
  let n = 0;
  for (const t of ALL_TOOLS) {
    n += t.name.length + (t.description ?? '').length;
    try {
      n += JSON.stringify(z.toJSONSchema(t.schema)).length;
    } catch {
      /* 拿不到 schema 就算了 */
    }
  }
  return n;
}

/**
 * 极小的表达式求值器：递归下降，只认 + - * / % 和括号。
 * 不用 eval / new Function —— 工具是给模型调用的，别在这儿留注入面。
 */
function safeEval(src: string): number | null {
  let i = 0;
  const s = src;

  const skip = (): void => {
    while (i < s.length && /\s/.test(s[i]!)) i += 1;
  };

  function parseExpr(): number {
    let v = parseTerm();
    for (;;) {
      skip();
      const c = s[i];
      if (c === '+') {
        i += 1;
        v += parseTerm();
      } else if (c === '-') {
        i += 1;
        v -= parseTerm();
      } else {
        return v;
      }
    }
  }

  function parseTerm(): number {
    let v = parseUnary();
    for (;;) {
      skip();
      const c = s[i];
      if (c === '*') {
        i += 1;
        v *= parseUnary();
      } else if (c === '/') {
        i += 1;
        v /= parseUnary();
      } else if (c === '%') {
        i += 1;
        v %= parseUnary();
      } else {
        return v;
      }
    }
  }

  function parseUnary(): number {
    skip();
    if (s[i] === '+') {
      i += 1;
      return parseUnary();
    }
    if (s[i] === '-') {
      i += 1;
      return -parseUnary();
    }
    return parseAtom();
  }

  function parseAtom(): number {
    skip();
    if (s[i] === '(') {
      i += 1;
      const v = parseExpr();
      skip();
      if (s[i] !== ')') throw new Error('括号不配对');
      i += 1;
      return v;
    }
    const start = i;
    while (i < s.length && /[0-9.]/.test(s[i]!)) i += 1;
    if (i === start) throw new Error(`位置 ${i} 不是数字`);
    const v = Number(s.slice(start, i));
    if (!Number.isFinite(v)) throw new Error('数字不合法');
    return v;
  }

  try {
    const v = parseExpr();
    skip();
    if (i !== s.length) return null;
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
