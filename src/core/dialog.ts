/**
 * ask_parent（v3 M3.5，设计见 docs/V3-M3.5-DESIGN.md）。
 *
 * 子 agent 中途向父会话提问：本轮暂停，父回答后用 `delegate(resume=…)` 继续。
 * 真实行为在 agent.ts 的 `callTools` 里特判（同 delegate / load_skill）：
 * 工具本身拿不到 runtime，也不该拿；直接调用它只会得到一句说明。
 *
 * 三条自律：
 *   · **只传一句话**：问题截到 2000 字符 —— 父上下文是共享的，别用它搬数据
 *   · **不做通信总线**：只是「暂停 + 把问题带回父层」，不广播、不寻址
 *   · **权限不越过一层**：子 agent 只能问父，不能直接问用户
 */
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';

export const ASK_TOOL = 'ask_parent';
/** 一句话问题的上限：超了截断，不报错（截断比拒绝更不打断思路） */
export const ASK_MAX_CHARS = 2000;

export const askParentTool = tool(
  async (): Promise<string> => 'ERROR: ask_parent 只在借调子任务里由执行层处理',
  {
    name: ASK_TOOL,
    description:
      '向发起这次借调的父会话提问；本轮会暂停，父回答后用 delegate(resume=…) 继续。只在子任务里可用。',
    schema: z.object({ question: z.string().describe('要问父会话的问题，一句话说清缺什么') }),
  },
) as StructuredToolInterface;

export function isAskTool(name: string): boolean {
  return name === ASK_TOOL;
}

/** 把问题裁到上限；空白问题返回空串，由执行层兜一句 ERROR */
export function clipQuestion(text: string): string {
  const t = (text ?? '').trim();
  return t.length > ASK_MAX_CHARS ? `${t.slice(0, ASK_MAX_CHARS)}…` : t;
}
