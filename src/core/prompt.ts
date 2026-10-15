/**
 * Prompt 骨架 —— 整个设计里最要紧的一个文件。
 *
 * 规矩只有一条：**STABLE_PREFIX 逐字节不变**。
 *
 * 阶段 6.7 测出来的两件事决定了这个形状：
 *   1. 未命中 = (入 mod 64) + 64k —— 改内容动不了它，但改了前缀，
 *      后面全部作废，等于每轮重付全价。
 *   2. 挂在用户消息末尾的那一段，落在「必然未命中」的尾巴里，
 *      边际成本 ≈ 0。
 *
 * 所以角色/模块绝不能写进 system（那样切一次模块，整个历史都失效）。
 * 它挂在每条用户消息的末尾 —— 切模块只多出尾巴那几个 token。
 *
 * 这个文件里改任何一个字符，第 1 条就失效一次（一次性全盘作废税）。
 */
import { fragmentFor, type AgentModule } from './modules.js';

/** ⚠ 冻结区。改一个字 = 全盘缓存作废一次。要调风格请走模块 fragment */
export const STABLE_PREFIX = [
  '你是 hive，一个在终端里跑的编程助手。',
  '当前角色由用户消息末尾的【模块:…】块给出；没有那个块时按下面的默认规则回答。',
  '',
  '工具：读文件（相对路径）、算数（算式）。',
  '历史和工具里没有的信息就说不知道，不要编。',
  '',
  '输出规则，按优先级：',
  '1 只答问题本身。不评论对话（"我明白你在干嘛"）、不提议下一步（"你可以试试…"）、',
  '  不问"还需要什么"。',
  '2 不用问候、称呼、客套、表情符号。不要称呼用户。',
  '3 不解释自己正在做什么、不预告要做什么、不复述用户的意图。',
  '4 不把能力或限制列成清单——除非用户明确要求"列出"。',
  '5 默认一句话。只有用户要求展开、或答案必须分步才有用时才分段。',
  '6 没听懂就问一句，不要列五种可能。',
  '',
  '例子：',
  '  问"你能做什么" → "读文件、算数。给我路径或算式。"',
  '  问"如何改回显名" → "改不了，那是客户端设置。要改得动它的配置。"',
].join('\n');

export const TAIL_MARK = '【模块:';

/** 贴尾的 token 粗估（中英混排按 3 字符 1 token） */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3);
}

export interface RenderOptions {
  /** 关掉尾部角色片。关掉后跨模块切换完全同字节 —— 用于 A/B */
  tail: boolean;
}

/**
 * 把用户原文渲染成实际发出去的那条 HumanMessage。
 * 开尾时 = 原文 + 【模块:…】角色片；关尾时 = 原文本身。
 */
export function renderUserContent(
  text: string,
  mod: AgentModule,
  opts: RenderOptions = { tail: true },
): string {
  if (!opts.tail) return text;
  return text + fragmentFor(mod);
}

/** 前缀的组成报告，/anatomy 用 */
export function prefixReport(mod: AgentModule, tail: boolean): Array<[string, number]> {
  return [
    ['system 前缀（冻结区）', STABLE_PREFIX.length],
    ['尾部角色片', tail ? fragmentFor(mod).length : 0],
  ];
}
