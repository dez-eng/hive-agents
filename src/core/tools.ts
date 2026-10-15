/**
 * 工具。描述已瘦身 —— 它每轮都在 prompt 里，多一个字就是每轮多一个字。
 * 工具 schema 属于冻结区的一部分，改描述同样会作废缓存。
 *
 * v2：工具**一次加齐**（§7 的一次性前缀税）。加 write_file（C 修复要动手）
 * 与 delegate（借调入口）都在这版进 ALL_TOOLS —— 别边做边加，那是每加一个
 * 就作废一次全盘缓存。
 *
 * ⚠ 注意：工具定义给**所有模块**（指令层全套），能真正调用哪个由执行层
 * 按模块白名单挡（见 agent.ts 的 callTools）。delegate 还多一层：它不在
 * 本文件里真正执行，而是由执行层接管，先过令牌与预算闸门。
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

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

export const writeFileTool = tool(
  async ({ path, content }: { path: string; content: string }): Promise<string> => {
    const target = resolve(ROOT, path);
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      return 'ERROR: 越界，只能写项目目录内的文件';
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
      return `OK: 已写入 ${path}（${content.length} 字符）`;
    } catch (e) {
      return `ERROR: 写不了 ${path}（${e instanceof Error ? e.message : String(e)}）`;
    }
  },
  {
    name: 'write_file',
    description: '把内容写入（覆盖）项目目录内的文件，path 用相对路径。',
    schema: z.object({
      path: z.string().describe('相对路径'),
      content: z.string().describe('要写入的完整内容'),
    }),
  },
);

/**
 * 借调的入口。**这里不真正干活** —— 真正的执行在 agent.ts 的 callTools 里
 * 被特判接管，因为借调必须先过执行层的令牌 + 预算闸门（§4），而工具本身
 * 拿不到那些上下文。模型直接调到这里只会拿到一句提醒。
 */
export const delegateTool = tool(
  async (): Promise<string> => {
    return 'ERROR: delegate 必须经执行层（它会先校验令牌与预算），这里不执行';
  },
  {
    name: 'delegate',
    description: '把子任务交给另一个 agent（需 A 签发的令牌，受预算闸门限制）。预算给足，太小会在子任务里被熔断。',
    schema: z.object({
      to: z.enum(['A', 'B', 'C', 'D']).describe('借调目标身份'),
      goal: z.string().describe('一句话目标'),
      slice: z.string().describe('结构化输入切片：文件路径 + 行号 + 片段，不含对话原文'),
      expect: z.string().describe('期望产物的形状'),
      budgetTokens: z
        .number()
        .int()
        .nonnegative()
        .describe('这个子任务的预算（token）。太小会被熔断；需要读文件/改文件的任务建议 ≥ 2000'),
    }),
  },
);

export const ALL_TOOLS = [calculator, readFileTool, writeFileTool, delegateTool];

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
