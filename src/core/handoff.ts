/**
 * 交接 schema —— v2 里 agent 之间**只传结构化切片，不传对话原文**。
 *
 * 原文一传，接手的 agent 就得把发起方的历史重读一遍：那是双份未命中，
 * 而且把「谁的记忆该是谁的」这条边界直接抹掉了（见 docs/V2-PLAN.md §1）。
 *
 * 用 zod 定形状，就是为了让「省事地塞一整段历史进去」这件事写不出来。
 */
import { z } from 'zod';

export const AGENT_IDS = ['A', 'B', 'C', 'D'] as const;
export const agentIdSchema = z.enum(AGENT_IDS);

export const HandoffInputSchema = z.object({
  /** 子任务 id —— 子会话 thread 里也带它，便于账本对账 */
  taskId: z.string().min(1),
  from: agentIdSchema,
  to: agentIdSchema,
  /** 一句话目标 */
  goal: z.string().min(1),
  /** 输入切片：结构化文本（文件 + 行号 + 片段），不是对话原文 */
  slice: z.string(),
  /** 期望产物的形状 */
  expect: z.string(),
  /** 这个子任务的预算闸门（token） */
  budgetTokens: z.number().int().nonnegative(),
});

export const HandoffResultSchema = z.object({
  taskId: z.string().min(1),
  ok: z.boolean(),
  /** 结构化产物 */
  output: z.string().optional(),
  /** 实际消耗 */
  tokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  notes: z.string().optional(),
  /** 是否被预算闸门熔断 */
  budgetHit: z.boolean(),
});

export type HandoffInput = z.infer<typeof HandoffInputSchema>;
export type HandoffResult = z.infer<typeof HandoffResultSchema>;

/** 解析失败时给一句人话，而不是抛一坨 zod 错误 */
export function parseHandoffInput(x: unknown): { ok: true; value: HandoffInput } | { ok: false; reason: string } {
  const r = HandoffInputSchema.safeParse(x);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, reason: r.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('；') };
}

export function parseHandoffResult(x: unknown): { ok: true; value: HandoffResult } | { ok: false; reason: string } {
  const r = HandoffResultSchema.safeParse(x);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, reason: r.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('；') };
}

/** 子任务 id：序号 + 四位随机，账本里一眼能认出 */
export function makeTaskId(seq: number, rnd: string = Math.random().toString(16).slice(2, 6)): string {
  return `t${String(seq).padStart(3, '0')}-${rnd}`;
}

/**
 * 子会话 thread —— 「无状态」的物理落点。
 * 与 A 的 thread 不同 → checkpoint 隔离 → B/C/D 拿不到 A 的历史，
 * 不是靠提示词叮嘱，是它们根本读不到。
 */
export function subThread(thread: string, as: (typeof AGENT_IDS)[number], taskId: string): string {
  return `${thread}#${as}#${taskId}`;
}

/**
 * v3：独立会话的 thread —— `solo#B`，**可续**。
 * 与借调子任务（`main#C#t001-xxxx`，跑完即弃 checkpoint）相对：
 * 独立会话是「这个 agent 单独当产品用」，它的 checkpoint 必须留着，
 * 否则 `hive --as B --continue` 无从谈起（见 docs/V3-PLAN.md §2.3）。
 */
export function soloThread(as: (typeof AGENT_IDS)[number]): string {
  return `solo#${as}`;
}
