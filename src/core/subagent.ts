/**
 * runSubagent —— v2 §3 / §5 的运行时，把「借调」这件事真正跑起来。
 *
 * 四件事按顺序发生，顺序本身就是设计：
 *   1. **执行层授权**（grant.ts 的 authorizeDelegate）：身份表 → 令牌归属 → 令牌内容。
 *      挡在花模型钱之前 —— 模型看不到这套规矩，也绕不过。
 *   2. **A 自动签发**（§4）：A 借调时顺手给被借调者签一张令牌，并按 makeChildDelegate
 *      给它一层借调上下文 —— 于是 A→B→C 的嵌套在子任务里也能继续。
 *   3. **独立 thread**（handoff.ts 的 subThread）：B/C/D 拿不到 A 的历史。
 *      「无状态」不是嘴上说的，是 checkpoint 物理隔离。
 *   4. **只递结构化切片 + 记账留痕**（renderSlice / logTurn / insertHandoff）。
 *
 * 契约：runner 只需实现 run()。生产线传 HiveAgent，测试传假 runner —— 零 API。
 */
import type { AgentId, AgentModule } from './modules.js';
import type { HandoffInput, HandoffResult } from './handoff.js';
import { subThread } from './handoff.js';
import { authorizeDelegate, debitToken, issueToken, type Token } from './grant.js';
import { isBudgetExceeded, tokenSpent } from './budget.js';
import type { Ledger } from './ledger.js';
import type { TokenMeter } from './meter.js';
import type { DelegateContext, TurnRequest, TurnResult } from './agent.js';

/** 跑一轮的最小接口 —— HiveAgent 天然满足它，测试里塞假 runner 也满足 */
export interface TurnRunner {
  run(req: TurnRequest, onChunk?: (piece: string) => void): Promise<TurnResult>;
}

export interface RunSubagentDeps {
  /** 跑子任务的执行器（通常 new HiveAgent()，独立 thread） */
  runner: TurnRunner;
  ledger: Ledger;
  /** 子 agent 用的模块（通常 AGENTS[as].home 对应的那个） */
  module: AgentModule;
  /** 尾部角色片开关 */
  tail: boolean;
  /** 可注入的时钟，测试用 */
  now?: () => number;
  /**
   * 给子任务造一层借调上下文。有它，子任务里才能再借调（A→B→C 的嵌套）——
   * 传给子任务的是 A 刚签给 as 的那张令牌，于是 as 借调下一层时能过授权。
   */
  makeChildDelegate?: (childToken: Token, childThread: string) => DelegateContext | undefined;
}

export interface RunSubagentOptions {
  /** 被借调的身份（子 agent） */
  as: AgentId;
  /** 发起借调的身份（栈顶那个） */
  from: AgentId;
  /** 结构化交接输入 */
  input: HandoffInput;
  /** 发起方手上的令牌；没有就 null（A 免令牌，副 agent 会被拒） */
  token: Token | null;
  /** 主会话 thread —— 子 thread 由它派生 */
  thread: string;
  deps: RunSubagentDeps;
  onChunk?: (piece: string) => void;
}

/**
 * 把交接输入渲染成子 agent 的唯一输入。
 * 只有目标 / 切片 / 期望产物三项 —— 没有对话历史这个字段，想塞也塞不进来。
 */
export function renderSlice(input: HandoffInput): string {
  return [`目标：${input.goal}`, `输入切片：\n${input.slice}`, `期望产物：${input.expect}`].join('\n');
}

/** 把子任务这一轮记进账本：agent 栏写 as，task_id 带上，便于事后对账 */
function logTurn(
  o: RunSubagentOptions,
  meter: TokenMeter,
  thread: string,
  budget: number,
  budgetHit: boolean,
): void {
  o.deps.ledger.insert({
    kind: 'turn',
    threadId: thread,
    module: o.deps.module.id,
    calls: meter.calls,
    inTok: meter.inTok,
    cacheHit: meter.cacheHit,
    outTok: meter.outTok,
    reasoning: meter.reasoning,
    costUsd: meter.cost(),
    agent: o.as,
    taskId: o.input.taskId,
    budgetTok: budget,
    budgetHit: budgetHit ? 1 : 0,
    band: meter.band,
  });
}

export async function runSubagent(o: RunSubagentOptions): Promise<HandoffResult> {
  const now = (o.deps.now ?? Date.now)();
  const budget = o.input.budgetTokens;

  // 1. 执行层授权 —— 没过就返回结构化失败，不进模型、不花钱
  const verdict = authorizeDelegate({
    from: o.from,
    to: o.as,
    token: o.token,
    needTokens: budget,
    now,
  });
  if (!verdict.ok) {
    return { taskId: o.input.taskId, ok: false, tokens: 0, costUsd: 0, budgetHit: false, notes: verdict.reason };
  }

  // 2. 独立 thread。子 agent 读的是自己的 checkpoint，与发起方的历史物理隔离
  const thread = subThread(o.thread, o.as, o.input.taskId);

  // §4：A 借调时自动签发 —— 让被借调者拿到令牌，并给它一层借调上下文，
  // 于是 A→B→C 的嵌套能在子任务里继续（B 拿这张令牌去借调 C/D）。
  let childDelegate: DelegateContext | undefined;
  if (o.from === 'A') {
    const issued = issueToken(o.as, { budgetTokens: budget, note: 'A 自动签发' });
    if (issued.ok) {
      o.deps.ledger.saveToken(issued.token);
      childDelegate = o.deps.makeChildDelegate?.(issued.token, thread);
    }
  }

  const text = renderSlice(o.input);

  let tokens = 0;
  let costUsd = 0;
  let budgetHit = false;
  let ok = true;
  let output: string | undefined;
  let notes: string | undefined;

  try {
    const req: TurnRequest = {
      text,
      threadId: thread,
      module: o.deps.module,
      tail: o.deps.tail,
      budgetTokens: budget,
      ...(childDelegate ? { delegate: childDelegate } : {}),
    };
    const res = await o.deps.runner.run(req, o.onChunk);
    tokens = tokenSpent(res.meter);
    costUsd = res.meter.cost();
    budgetHit = res.budgetHit;
    if (res.text) output = res.text;
    if (budgetHit) notes = '被预算闸门熔断';
    logTurn(o, res.meter, thread, budget, budgetHit);
  } catch (e) {
    if (isBudgetExceeded(e)) {
      // runner 直接把熔断抛出来了（没在内部兜住）—— 一样算熔断，一样留痕
      budgetHit = true;
      notes = '被预算闸门熔断（异常路径）';
    } else {
      ok = false;
      notes = e instanceof Error ? e.message : String(e);
    }
  }

  // 3. 扣令牌 + 落 handoffs（痕迹策略：checkpoint 弃、这张表留）
  if (o.token && tokens > 0) {
    const next = debitToken(o.token, tokens);
    o.deps.ledger.updateTokenSpent(next.id, next.spent);
  }
  o.deps.ledger.insertHandoff({
    taskId: o.input.taskId,
    from: o.from,
    to: o.as,
    goal: o.input.goal,
    expect: o.input.expect,
    budgetTok: budget,
    tokens,
    costUsd,
    ok,
    budgetHit,
    ...(notes ? { notes } : {}),
    ...(output ? { output } : {}),
  });

  return {
    taskId: o.input.taskId,
    ok,
    ...(output ? { output } : {}),
    tokens,
    costUsd,
    budgetHit,
    ...(notes ? { notes } : {}),
  };
}
