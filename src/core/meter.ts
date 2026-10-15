/**
 * TokenMeter —— 记账的全部入口。
 *
 * 移植自阶段 6.7 的 Meter：几何律、成本公式、字段名一字未改，
 * 只把「一份 usage 拆成 (入/出/命中/思考)」那一步写得更耐造 ——
 * JS 侧的 DeepSeek 集成把 prompt_cache_hit_tokens 往三种地方夹带，
 * 任何一种都得认出来。
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';

import { BLOCK, currentBand, maxOut, modelName } from './config.js';
import { costOf, inputCostOf, reasonCostOf, type Band } from './cost.js';

export interface TurnStats {
  calls: number;
  inTok: number;
  outTok: number;
  cacheHit: number;
  reasoning: number;
}

export function emptyStats(): TurnStats {
  return { calls: 0, inTok: 0, outTok: 0, cacheHit: 0, reasoning: 0 };
}

export function addStats(a: TurnStats, b: TurnStats): TurnStats {
  return {
    calls: a.calls + b.calls,
    inTok: a.inTok + b.inTok,
    outTok: a.outTok + b.outTok,
    cacheHit: a.cacheHit + b.cacheHit,
    reasoning: a.reasoning + b.reasoning,
  };
}

export function subStats(a: TurnStats, b: TurnStats): TurnStats {
  return {
    calls: a.calls - b.calls,
    inTok: a.inTok - b.inTok,
    outTok: a.outTok - b.outTok,
    cacheHit: a.cacheHit - b.cacheHit,
    reasoning: a.reasoning - b.reasoning,
  };
}

function toInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function firstInt(...vals: unknown[]): number {
  for (const v of vals) {
    const n = toInt(v);
    if (n) return n;
  }
  return 0;
}

function asRecord(obj: unknown): Record<string, unknown> | undefined {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : undefined;
}

function pick(obj: unknown, ...keys: string[]): Record<string, unknown> | undefined {
  const o = asRecord(obj);
  if (!o) return undefined;
  for (const k of keys) {
    const v = o[k];
    const r = asRecord(v);
    if (r) return r;
  }
  return undefined;
}

function detailsOf(obj: unknown): Record<string, unknown> | undefined {
  return pick(
    obj,
    'completion_tokens_details',
    'completionTokensDetails',
    'output_token_details',
    'outputTokenDetails',
  );
}

/**
 * 从一条生成结果里抠出四项计量。三层回退，谁先给值算谁的：
 *   1. usage_metadata          langchain 标准位
 *   2. response_metadata       DeepSeek 集成的常见夹带位
 *   3. llmOutput.tokenUsage    最后一层兜底
 */
export function extractUsage(msg: unknown, llmOutput?: unknown): TurnStats {
  const s = emptyStats();
  const m = asRecord(msg);

  const um = pick(m, 'usage_metadata', 'usageMetadata');
  if (um) {
    s.inTok = firstInt(um.input_tokens, um.inputTokens);
    s.outTok = firstInt(um.output_tokens, um.outputTokens);
    const ind = pick(um, 'input_token_details', 'inputTokenDetails');
    s.cacheHit = firstInt(
      ind?.cache_read,
      ind?.cached_tokens,
      ind?.cache_read_input_tokens,
      ind?.cacheRead,
      ind?.cachedTokens,
    );
    const outd = detailsOf(um);
    s.reasoning = firstInt(outd?.reasoning, outd?.reasoning_tokens, outd?.reasoningTokens);
  }

  const tu =
    pick(m?.response_metadata, 'tokenUsage', 'token_usage', 'usage') ??
    pick(llmOutput, 'tokenUsage', 'token_usage', 'usage');

  if (tu) {
    if (!s.inTok) {
      s.inTok = firstInt(tu.prompt_tokens, tu.promptTokens, tu.input_tokens, tu.inputTokens);
    }
    if (!s.outTok) {
      s.outTok = firstInt(
        tu.completion_tokens,
        tu.completionTokens,
        tu.output_tokens,
        tu.outputTokens,
      );
    }
    if (!s.cacheHit) {
      s.cacheHit = firstInt(
        tu.prompt_cache_hit_tokens,
        tu.promptCacheHitTokens,
        tu.cached_tokens,
        tu.cache_read_input_tokens,
        tu.cacheRead,
      );
    }
    if (!s.reasoning) {
      const cd = detailsOf(tu);
      s.reasoning = firstInt(cd?.reasoning_tokens, cd?.reasoningTokens, cd?.reasoning);
    }
  }

  s.calls = 1;
  return s;
}

export class TokenMeter extends BaseCallbackHandler {
  override name = 'hive-meter';

  calls = 0;
  inTok = 0;
  outTok = 0;
  cacheHit = 0;
  reasoning = 0;
  truncated = false;

  /** 最后一次调用的原始计量对象 —— /doctor 靠它校准字段名 */
  lastRaw: { message?: unknown; llmOutput?: unknown } | null = null;

  private readonly modelId: string;
  private readonly bandAt: Band;

  constructor(opts: { model?: string; band?: Band } = {}) {
    super();
    this.modelId = opts.model ?? modelName();
    this.bandAt = opts.band ?? currentBand();
  }

  get model(): string {
    return this.modelId;
  }

  get band(): Band {
    return this.bandAt;
  }

  override handleLLMEnd(output: LLMResult): void {
    const llmOutput = (output as { llmOutput?: unknown }).llmOutput;
    const generations = (output as { generations?: unknown }).generations;
    let sawGeneration = false;

    if (Array.isArray(generations)) {
      for (const group of generations as unknown[]) {
        if (!Array.isArray(group)) continue;
        for (const gen of group) {
          const msg = (gen as { message?: unknown } | undefined)?.message;
          this.bump(extractUsage(msg, llmOutput));
          this.lastRaw = msg === undefined
            ? { llmOutput }
            : { message: msg, llmOutput };
          sawGeneration = true;
        }
      }
    }
    if (!sawGeneration) {
      // 有些 provider 只在 llmOutput 里给计量
      this.bump(extractUsage(undefined, llmOutput));
      this.lastRaw = { llmOutput };
    }

    const cap = maxOut();
    if (cap && this.outTok >= cap) this.truncated = true;
  }

  private bump(s: TurnStats): void {
    this.calls += s.calls;
    this.inTok += s.inTok;
    this.outTok += s.outTok;
    this.cacheHit += s.cacheHit;
    this.reasoning += s.reasoning;
  }

  /** 合并一份外部统计（会话累计用） */
  absorb(other: TurnStats): void {
    this.bump(other);
  }

  stats(): TurnStats {
    return {
      calls: this.calls,
      inTok: this.inTok,
      outTok: this.outTok,
      cacheHit: this.cacheHit,
      reasoning: this.reasoning,
    };
  }

  /** 未命中的输入 token —— 按全价计费的那部分 */
  missTok(): number {
    return Math.max(this.inTok - this.cacheHit, 0);
  }

  /** 可见输出 = 输出 − 思考。「话长」能管的只有这一栏 */
  visibleTok(): number {
    return Math.max(this.outTok - this.reasoning, 0);
  }

  /** 未命中里有几块（余额 ÷ 64）。常态 2~4，上一轮输出太胖会炸到 7 */
  kBlocks(): number {
    const miss = this.missTok();
    if (!miss || !this.calls) return 0;
    return (miss - (this.inTok % BLOCK)) / BLOCK;
  }

  /** 缓存命中率。0 就是冷缓存（/new 之后第一轮） */
  hitRate(): number {
    return this.inTok ? this.cacheHit / this.inTok : 0;
  }

  inCost(): number {
    return inputCostOf({ miss: this.missTok(), hit: this.cacheHit }, this.modelId, this.bandAt);
  }

  cost(): number {
    return costOf(
      { miss: this.missTok(), hit: this.cacheHit, out: this.outTok },
      this.modelId,
      this.bandAt,
    );
  }

  reasonCost(): number {
    return reasonCostOf(this.reasoning, this.modelId, this.bandAt);
  }

  /** 思考占总花费几成。0 就是没得算 */
  reasonShare(): number {
    const c = this.cost();
    return c ? this.reasonCost() / c : 0;
  }
}

/** 会话级累计器 —— 只加数字，不带回调 */
export class SessionTally {
  total = emptyStats();
  costUsd = 0;
  turns = 0;
  toolTurns = 0;
  truncated = 0;

  add(meter: TokenMeter): void {
    this.total = addStats(this.total, meter.stats());
    this.costUsd += meter.cost();
    this.turns += 1;
    if (meter.calls > 1) this.toolTurns += 1;
    if (meter.truncated) this.truncated += 1;
  }

  get avgCost(): number {
    return this.turns ? this.costUsd / this.turns : 0;
  }

  get avgOut(): number {
    return this.turns ? this.total.outTok / this.turns : 0;
  }

  get visibleTot(): number {
    return Math.max(this.total.outTok - this.total.reasoning, 0);
  }

  reset(): void {
    this.total = emptyStats();
    this.costUsd = 0;
    this.turns = 0;
    this.toolTurns = 0;
    this.truncated = 0;
  }
}
