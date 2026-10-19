/**
 * runSubagent / continueSubagent —— v2 §3 / §5 的运行时，把「借调」这件事真正跑起来。
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
 * v3 M3 把「一次性交办」升级为**可续会话**：首跑由 runSubagent 派生 thread，
 * 续跑由 continueSubagent 原样复用同一个 thread —— 子 agent 因此看得到自己上一轮。
 * 两条路共用 execute()：授权、记账、扣令牌、落 handoffs 完全同一条。
 *
 * 契约：runner 只需实现 run()。生产线传 HiveAgent，测试传假 runner —— 零 API。
 */
import type { AgentId, AgentModule } from './modules.js';
import type { HandoffInput, HandoffResult } from './handoff.js';
import { subThread } from './handoff.js';
import { authorizeDelegate, issueToken, type Token } from './grant.js';
import { isBudgetExceeded, tokenSpent } from './budget.js';
import type { Ledger } from './ledger.js';
import type { TokenMeter } from './meter.js';
import { TASKS } from './tasks.js';
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

/** 把这一轮记进账本：agent 栏写 as，task_id 带上，便于事后对账 */
function logTurn(
  as: AgentId,
  taskId: string,
  module: AgentModule,
  ledger: Ledger,
  meter: TokenMeter,
  thread: string,
  budget: number,
  budgetHit: boolean,
): void {
  ledger.insert({
    kind: 'turn',
    threadId: thread,
    module: module.id,
    calls: meter.calls,
    inTok: meter.inTok,
    cacheHit: meter.cacheHit,
    outTok: meter.outTok,
    reasoning: meter.reasoning,
    costUsd: meter.cost(),
    agent: as,
    taskId,
    budgetTok: budget,
    budgetHit: budgetHit ? 1 : 0,
    band: meter.band,
  });
}

/**
 * 首跑与续跑共用的执行核。
 * 「thread 怎么来」「输入文本怎么来」由调用方决定，其余完全一致。
 */
interface ExecuteOptions {
  as: AgentId;
  from: AgentId;
  token: Token | null;
  /** 现成的子会话 thread（首跑由 runSubagent 派生，续跑原样复用） */
  thread: string;
  taskId: string;
  /** 这一步发给子 agent 的文本（首跑是 renderSlice，续跑是追加原文） */
  text: string;
  /** 落 handoffs 的摘要 */
  goal: string;
  expect: string;
  budgetTokens: number;
  deps: RunSubagentDeps;
  onChunk?: (piece: string) => void;
  /** A 借调时自动签发子令牌（续跑同一策略：新签一张，旧的自然过期） */
  issueChildToken: boolean;
}

async function executeInner(o: ExecuteOptions): Promise<HandoffResult> {
  const now = (o.deps.now ?? Date.now)();
  const budget = o.budgetTokens;

  // 1. 执行层授权 —— 没过就返回结构化失败，不进模型、不花钱
  const verdict = authorizeDelegate({
    from: o.from,
    to: o.as,
    token: o.token,
    needTokens: budget,
    now,
  });
  if (!verdict.ok) {
    return { taskId: o.taskId, ok: false, tokens: 0, costUsd: 0, budgetHit: false, notes: verdict.reason };
  }

  // v4 M4.1：并发预留 —— 授权检查与真正扣款之间不能留窗口，
  // 否则两个并行子任务会同时看到同一份余额（超卖）。预留是原子条件更新。
  // budget=0 表示不封顶（沿用 budget.ts 的语义），这时不预留，只按实际消耗记账。
  let reserved = 0;
  if (o.token && budget > 0) {
    if (!o.deps.ledger.reserveToken(o.token.id, budget)) {
      return {
        taskId: o.taskId,
        ok: false,
        tokens: 0,
        costUsd: 0,
        budgetHit: false,
        notes: `令牌 ${o.token.id} 预算不足（并发预留失败）`,
      };
    }
    reserved = budget;
  }

  // §4：A 借调时自动签发 —— 让被借调者拿到令牌，并给它一层借调上下文，
  // 于是 A→B→C 的嵌套能在子任务里继续（B 拿这张令牌去借调 C/D）。
  let childDelegate: DelegateContext | undefined;
  if (o.issueChildToken && o.from === 'A') {
    const issued = issueToken(o.as, { budgetTokens: budget, note: 'A 自动签发' });
    if (issued.ok) {
      o.deps.ledger.saveToken(issued.token);
      childDelegate = o.deps.makeChildDelegate?.(issued.token, o.thread);
    }
  }

  let tokens = 0;
  let costUsd = 0;
  let budgetHit = false;
  let ok = true;
  let output: string | undefined;
  let notes: string | undefined;

  try {
    const req: TurnRequest = {
      text: o.text,
      threadId: o.thread,
      module: o.deps.module,
      tail: o.deps.tail,
      budgetTokens: budget,
      // v3 M2：子任务以**被借调的身份**跑 —— 工具集与网关判据都按它算，
      // 判罚也落在同一个账本上（带上 taskId 便于对账）
      agent: o.as,
      ledger: o.deps.ledger,
      taskId: o.taskId,
      ...(childDelegate ? { delegate: childDelegate } : {}),
    };
    const res = await o.deps.runner.run(req, o.onChunk);
    tokens = tokenSpent(res.meter);
    costUsd = res.meter.cost();
    budgetHit = res.budgetHit;
    if (res.text) output = res.text;
    if (budgetHit) notes = '被预算闸门熔断';
    logTurn(o.as, o.taskId, o.deps.module, o.deps.ledger, res.meter, o.thread, budget, budgetHit);
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

  // 3. 结算令牌 + 落 handoffs（痕迹策略：checkpoint 弃、这张表留）
  // v4 M4.1：预留 → 实际消耗（多退少补），原子增量；不再读旧值覆盖。
  if (o.token) {
    o.deps.ledger.settleToken(o.token.id, reserved, tokens);
  }
  o.deps.ledger.insertHandoff({
    taskId: o.taskId,
    from: o.from,
    to: o.as,
    goal: o.goal,
    expect: o.expect,
    budgetTok: budget,
    tokens,
    costUsd,
    ok,
    budgetHit,
    ...(notes ? { notes } : {}),
    ...(output ? { output } : {}),
    thread: o.thread,
  });

  return {
    taskId: o.taskId,
    ok,
    ...(output ? { output } : {}),
    tokens,
    costUsd,
    budgetHit,
    ...(notes ? { notes } : {}),
    thread: o.thread,
  };
}

/**
 * v4 M4.1：执行核外再包一层任务登记。
 *
 * 登记放在 executeInner 之外，是为了覆盖它的**每一条**返回路径
 * （授权拒、预留失败、正常完成、熔断）以及异常路径 —— /tasks 才不会漏任务。
 */
async function execute(o: ExecuteOptions): Promise<HandoffResult> {
  TASKS.start({
    taskId: o.taskId,
    from: o.from,
    to: o.as,
    goal: o.goal,
    budgetTokens: o.budgetTokens,
  });
  try {
    const res = await executeInner(o);
    TASKS.finish(o.taskId, res);
    return res;
  } catch (e) {
    TASKS.fail(o.taskId, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

export async function runSubagent(o: RunSubagentOptions): Promise<HandoffResult> {
  return execute({
    as: o.as,
    from: o.from,
    token: o.token,
    thread: subThread(o.thread, o.as, o.input.taskId),
    taskId: o.input.taskId,
    text: renderSlice(o.input),
    goal: o.input.goal,
    expect: o.input.expect,
    budgetTokens: o.input.budgetTokens,
    deps: o.deps,
    ...(o.onChunk ? { onChunk: o.onChunk } : {}),
    issueChildToken: o.from === 'A',
  });
}

export interface ContinueSubagentOptions {
  /** 子会话身份（= 原子任务的 to） */
  as: AgentId;
  /** 这次是谁在续 */
  from: AgentId;
  /** 原子任务的发起方（handoff.from）—— 只有它能续 */
  owner: AgentId;
  token: Token | null;
  /** 原样复用，不重新派生 */
  thread: string;
  taskId: string;
  /** 追加给子 agent 的话 */
  text: string;
  budgetTokens: number;
  deps: RunSubagentDeps;
  onChunk?: (piece: string) => void;
}

/**
 * v3 M3：在同一个子会话里接着跑一轮。
 *
 * 与 runSubagent 的区别只有两处：thread 是现成的、输入是追加原文而不是结构化切片。
 * 授权仍走同一条闸；归属检查放在最前面（挡在花钱之前）。
 */
export async function continueSubagent(o: ContinueSubagentOptions): Promise<HandoffResult> {
  if (o.from !== o.owner) {
    return {
      taskId: o.taskId,
      ok: false,
      tokens: 0,
      costUsd: 0,
      budgetHit: false,
      notes: `${o.from} 不能续 ${o.owner} 发起的子会话 ${o.taskId}`,
    };
  }
  if (!o.thread) {
    return {
      taskId: o.taskId,
      ok: false,
      tokens: 0,
      costUsd: 0,
      budgetHit: false,
      notes: `交接 ${o.taskId} 没有 thread（M3 之前的记录），无法续跑`,
    };
  }
  const text = o.text.trim();
  if (!text) {
    return { taskId: o.taskId, ok: false, tokens: 0, costUsd: 0, budgetHit: false, notes: '续跑内容为空' };
  }
  return execute({
    as: o.as,
    from: o.from,
    token: o.token,
    thread: o.thread,
    taskId: o.taskId,
    text,
    goal: `[续跑] ${text}`,
    expect: '续跑',
    budgetTokens: o.budgetTokens,
    deps: o.deps,
    ...(o.onChunk ? { onChunk: o.onChunk } : {}),
    issueChildToken: o.from === 'A',
  });
}
