/**
 * 思考开关探针 —— `/thinktest` 的脑子，也是**思考预算分级的依据**。
 *
 * 为什么要实测：阶段 6.7 量出**思考占总花费 32%**，但「能不能关、怎么关」
 * 一直是悬案（当时那个 /thinktest 没跑出结论）。猜参数名没意义 ——
 * 同一个问题多跑几组候选，看哪一组把思考 token 打到 0，那才叫结论。
 *
 * 2026-10-15 实测结论（deepseek-flash，见 THINK_KWARGS 的注释）。
 *
 * 纯逻辑（候选表、判定、预算映射）全在这里，可单测；真调用走 runThinkProbe。
 */
import { ChatDeepSeek } from '@langchain/deepseek';
import { HumanMessage } from '@langchain/core/messages';

import { TokenMeter } from './meter.js';
import type { ThinkBudget } from './modules.js';

export interface ThinkCandidate {
  /** 给人看的名字，也是账本里 user_head 那栏 */
  label: string;
  /** 塞进请求体的额外字段（走 modelKwargs，不动前缀） */
  kwargs: Record<string, unknown>;
  /** 为什么觉得这组可能有用 —— 免得候选表变成一堆玄学 */
  why: string;
}

/**
 * 候选参数组。第一组必须是「什么都不传」的基线 ——
 * 没有基线就看不出「思考被关掉了」，只会看到一堆 0。
 */
export const THINK_CANDIDATES: ThinkCandidate[] = [
  { label: '默认', kwargs: {}, why: '基线：什么都不传，看它自己思考多少' },
  {
    label: 'thinking.type=disabled',
    kwargs: { thinking: { type: 'disabled' } },
    why: 'thinking 开关最常见的形状',
  },
  {
    label: 'thinking.type=enabled',
    kwargs: { thinking: { type: 'enabled' } },
    why: '对照组：显式打开，验证这个字段真被读进去了',
  },
  {
    label: 'reasoning_effort=minimal',
    kwargs: { reasoning_effort: 'minimal' },
    why: 'OpenAI 风格的思考档位，DeepSeek 兼容层可能认',
  },
  {
    label: 'reasoning_effort=none',
    kwargs: { reasoning_effort: 'none' },
    why: '同上，极端档 —— 能一下打到 0 最好',
  },
];

/**
 * 模块思考预算 → 请求字段。**这是 /thinktest 的产物**，不是猜的。
 *
 * 2026-10-15 实测（deepseek-flash，问题「1+1 只回数字」）：
 *   · 默认                       思考 38 · 出 40 · $0.000031
 *   · thinking.type=disabled     思考  0 · 出  1 · $0.000003  ← 开关
 *   · thinking.type=enabled      思考 27 · 出 29             ← 对照组，证明字段被读进去
 *   · reasoning_effort=minimal   思考 38（与默认同）          ← 无效
 *   · reasoning_effort=none      思考  0                     ← 也关得掉，但不留两个开关
 *
 * 结论：**只有开 / 关两态**，没有可用的「低」档。于是：
 *   · off  查表/算术类 —— 关思考（calc）
 *   · low  轻量角色也关 —— 省 token 是这个项目的宗旨；assistant 的活是「分工/委派」，
 *          不需要深思考。若发现主控变笨，把 modules.ts 里 assistant.think 改成 high 即可
 *   · high 审计/侦察类 —— 放开，由模型自决（默认已思考全开，不必显式 enabled）
 */
export const THINK_KWARGS: Record<ThinkBudget, Record<string, unknown>> = {
  off: { thinking: { type: 'disabled' } },
  low: { thinking: { type: 'disabled' } },
  high: {},
};

/** 一次探针的计量 */
export interface ThinkSample {
  label: string;
  ok: boolean;
  inTok: number;
  outTok: number;
  reasonTok: number;
  costUsd: number;
  error?: string;
}

/**
 * 从样本里挑出「真的把思考关掉了」的那一组。
 *
 * 三个前提缺一不可：基线本身在思考、这一组没报错、这组思考为 0。
 * 挑不出来就老实说挑不出来 —— 这比随便指一个参数名强。
 */
export function pickThinkingOff(samples: ThinkSample[]): ThinkSample | null {
  const ok = samples.filter((s) => s.ok);
  const base = ok[0];
  if (!base || base.reasonTok <= 0) return null; // 基线不思考 → 无从判断
  return ok.slice(1).find((s) => s.reasonTok === 0) ?? null;
}

/** 结论一句话。给命令用，也给将来的模块思考预算分级用 */
export function thinkVerdict(samples: ThinkSample[]): string {
  const ok = samples.filter((s) => s.ok);
  if (!ok.length) return '一组都没跑通 —— 先看 /doctor 的 key 与网络';
  const base = ok[0]!;
  if (base.reasonTok <= 0) return `基线（${base.label}）本来就没有思考量，这个模型/版本上分不出开关`;
  const off = pickThinkingOff(samples);
  if (off) return `关掉思考的开关：${off.label}`;
  const min = ok.slice(1).reduce((a, b) => (b.reasonTok < a.reasonTok ? b : a), base);
  return `没有候选能把思考打到 0；最低的是 ${min.label}（${min.reasonTok} token，基线 ${base.reasonTok}）`;
}

export interface ProbeOptions {
  model: string;
  question: string;
  candidates?: ThinkCandidate[];
}

/**
 * 真调用。每组候选一次 invoke，各带一个独立 TokenMeter。
 * 失败不抛 —— 记成一条 ok:false 的样本，让结论自己去处理。
 */
export async function runThinkProbe(o: ProbeOptions): Promise<ThinkSample[]> {
  const out: ThinkSample[] = [];
  for (const c of o.candidates ?? THINK_CANDIDATES) {
    const meter = new TokenMeter({ model: o.model });
    try {
      const llm = new ChatDeepSeek({
        model: o.model,
        temperature: 0,
        maxRetries: 0,
        modelKwargs: c.kwargs,
      });
      await llm.invoke([new HumanMessage(o.question)], { callbacks: [meter] });
      out.push({
        label: c.label,
        ok: true,
        inTok: meter.inTok,
        outTok: meter.outTok,
        reasonTok: meter.reasoning,
        costUsd: meter.cost(),
      });
    } catch (e) {
      out.push({
        label: c.label,
        ok: false,
        inTok: 0,
        outTok: 0,
        reasonTok: 0,
        costUsd: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}
