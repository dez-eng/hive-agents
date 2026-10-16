/**
 * 工具。描述已瘦身 —— 它每轮都在 prompt 里，多一个字就是每轮多一个字。
 * 工具 schema 属于冻结区的一部分，改描述同样会作废缓存。
 *
 * v2：工具**一次加齐**（§7 的一次性前缀税）。
 * v3 M2：工具归 **capability**（capability.ts），按身份装配 ——
 * 加一个工具只作废「装了它的那些 agent」的缓存，不是全盘（V3-PLAN §3.1）。
 * 本文件只负责工具**本身**：契约、上限、越界兜底。
 *
 * ⚠ 两层收权，别搞混：
 *   · 网关（policy.ts）按身份判「这一次准不准」—— 那才是判定
 *   · 这里的越界检查是**兜底**：工具可能被直接调用（测试、嵌入），得自己守住
 */
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { withinRoots } from './policy.js';

/**
 * 一次读取的上限。4,000 字符 ≈ 1,300 token，
 * 而工具结果必然是全价未命中 —— 这个数别放大。
 */
export const READ_LIMIT = 4000;

/**
 * `edit_file` 能处理的文件上限。再大就该是"显式选择整文件重写"，
 * 而不是让精确替换悄悄地做重活。
 */
export const EDIT_MAX_BYTES = 256 * 1024;

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
    const target = resolve(process.cwd(), path);
    // 兜底：真正的判定在网关；这里只保证「无论谁调，都出不了 roots」
    if (!withinRoots(target)) {
      return 'ERROR: 越界，只能读 roots（当前策略）内的文件';
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
    description: '读 roots 内的文件，path 用相对路径。',
    schema: z.object({ path: z.string().describe('相对路径，例如 src/index.ts') }),
  },
);

export const writeFileTool = tool(
  async ({ path, content }: { path: string; content: string }): Promise<string> => {
    const target = resolve(process.cwd(), path);
    if (!withinRoots(target)) {
      return 'ERROR: 越界，只能写 roots（当前策略）内的文件';
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
    description: '把内容写入（覆盖）roots 内的文件，path 用相对路径。',
    schema: z.object({
      path: z.string().describe('相对路径'),
      content: z.string().describe('要写入的完整内容'),
    }),
  },
);

/**
 * 精确替换（v3 M2.5）。**唯一匹配才动手** —— 这是它存在的全部理由：
 * 改一行不必把整个文件重吐一遍（输出 token 全价，还容易顺手改错别处）。
 *
 * 出现 0 次或多次都拒绝并说清「出现在哪些行」，让模型自己补上下文重试 ——
 * 宁可让它多试一次，也不猜它想改哪一处。
 */
export const editFileTool = tool(
  async ({
    path,
    old_string,
    new_string,
    replace_all,
  }: {
    path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }): Promise<string> => {
    const target = resolve(process.cwd(), path);
    if (!withinRoots(target)) {
      return 'ERROR: 越界，只能改 roots（当前策略）内的文件';
    }

    let text: string;
    try {
      const st = statSync(target);
      if (!st.isFile()) return `ERROR: 不是文件 ${path}`;
      if (st.size > EDIT_MAX_BYTES) {
        return `ERROR: 文件 ${st.size} 字节 > ${EDIT_MAX_BYTES}（256KB）—— 这种情况用 write_file 整文件重写`;
      }
      text = readFileSync(target, 'utf8');
    } catch {
      return `ERROR: 读不到 ${path}`;
    }

    if (!old_string) return 'ERROR: old_string 不能为空';
    if (old_string === new_string) return 'ERROR: old_string 与 new_string 一样，没什么可改';

    const hits: number[] = [];
    for (let at = text.indexOf(old_string); at !== -1; at = text.indexOf(old_string, at + old_string.length)) {
      hits.push(at);
    }

    const lineOf = (pos: number): number => text.slice(0, pos).split('\n').length;

    if (!hits.length) {
      const lines = text.split('\n').length;
      return `ERROR: 没找到这段（文件 ${lines} 行）—— 先用 read_file 看清原文，注意缩进与空格要一字不差`;
    }
    if (hits.length > 1 && !replace_all) {
      const shown = hits.slice(0, 8).map(lineOf).join('、');
      return (
        `ERROR: 这段出现 ${hits.length} 次（行 ${shown}${hits.length > 8 ? '…' : ''}）—— ` +
        '要么给更长的上下文让它唯一，要么加 replace_all: true'
      );
    }

    const first = hits[0]!;
    const next = replace_all
      ? text.split(old_string).join(new_string)
      : text.slice(0, first) + new_string + text.slice(first + old_string.length);

    try {
      writeFileSync(target, next, 'utf8');
    } catch (e) {
      return `ERROR: 写不了 ${path}（${e instanceof Error ? e.message : String(e)}）`;
    }

    const n = replace_all ? hits.length : 1;
    return (
      `OK: 已替换 ${path}:${lineOf(first)}（${old_string.length} → ${new_string.length} 字符` +
      `${n > 1 ? `，共 ${n} 处` : ''}）`
    );
  },
  {
    name: 'edit_file',
    description: '把文件里唯一的一段 old_string 换成 new_string（比整文件重写省）。',
    schema: z.object({
      path: z.string().describe('相对路径'),
      old_string: z.string().describe('原文片段，要一字不差且唯一'),
      new_string: z.string().describe('换成什么'),
      replace_all: z.boolean().optional().describe('多处都换（默认只许唯一匹配）'),
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
