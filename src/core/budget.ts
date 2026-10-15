/**
 * 预算闸门 —— v2 §6 的落点，**按 token 计**。
 *
 * 为什么不是美元：令牌的 `spent`、账本的 `budget_tok`、`checkToken` 的 `needTokens`
 * 全是 token；而美元随峰谷时价浮动，同一份预算在峰 / 谷两时值不一样的钱，
 * 拿它做闸门会漂。所以闸门与令牌、账本统一用 token 作单位。
 *
 * 规矩只有一条：**闸门在 callModel 之前**。输出之后才拦 = 钱已经花出去了，
 * 那不是闸门，是事后统计。
 *
 * 纯逻辑，不碰 IO —— 好测，也便于 runSubagent 与 agent 层共用。
 */

/** 熔断信号。抛出即代表「这一轮不该再调模型了」 */
export class BudgetExceeded extends Error {
  /** 熔断时已花掉的 token */
  readonly spent: number;
  /** 上限 */
  readonly budget: number;

  constructor(spent: number, budget: number, note = '') {
    super(`超预算：已花 ${spent} token > 上限 ${budget}${note ? `（${note}）` : ''}`);
    this.name = 'BudgetExceeded';
    this.spent = spent;
    this.budget = budget;
  }
}

/**
 * 一次任务流过多少 token —— 入 + 出。
 *
 * 缓存命中的入也算「流过」：它照样占着上下文窗口，也照样按命中价计费。
 * 只算 out 会让闸门对「读了一堆文件但话很少」的子任务完全失效。
 */
export function tokenSpent(m: { inTok: number; outTok: number }): number {
  return Math.max(m.inTok, 0) + Math.max(m.outTok, 0);
}

/** 超没超。0 / 负数 = 无闸门（沿用 HIVE_MAX_OUT 的「0 即不封顶」惯例） */
export function exceedsBudget(m: { inTok: number; outTok: number }, budgetTokens: number): boolean {
  if (!(budgetTokens > 0)) return false;
  return tokenSpent(m) > budgetTokens;
}

/**
 * 从可能被框架包了一层的异常里认出熔断。
 * LangGraph 会把 node 抛的错裹进自己的 Error，所以得顺着 cause 链找。
 */
export function isBudgetExceeded(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 6 && cur != null; depth += 1) {
    if (cur instanceof BudgetExceeded) return true;
    if (cur instanceof Error && cur.name === 'BudgetExceeded') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}
