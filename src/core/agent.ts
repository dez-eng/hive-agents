/**
 * 图与会话。
 *
 * 三条设计约束，都来自阶段 6.7 的实测：
 *
 * 1. system 提示不进 state、不进 checkpoint —— 每轮调用时临时拼在最前面。
 *    否则它会随历史累积，冻结区一膨胀，每轮都在为重复的 system 付钱。
 *
 * 2. **所有模块共享同一套工具定义**。工具 schema 在 prompt 开头，属于前缀的
 *    一部分；按模块换工具 = 换前缀 = 整个历史缓存作废。所以指令层给全套，
 *    权限收在【执行层】（call_tools 里按模块白名单挡）。
 *    这条也是 v2 的地基：权限不该靠提示词，该靠执行层。
 *
 * 3. 角色片挂在用户消息末尾（见 prompt.ts），切模块不动前缀。
 *
 * v2 又加了三层，都在执行层：
 *   · **预算闸门**（budget.ts）：闸门挂在 callModel 之前 —— 输出之后才拦就不叫闸门了。
 *   · **借调接管**：模型调 delegate 时，callTools 里特判，改由 runSubagent 执行
 *     （先过令牌 + 预算）。工具层的 delegate 是个占位，真正干活在这。
 *   · **思考预算分级**：按栈顶模块的 think 档选模型实例（`modelKwargs` 走请求体，
 *     不进 prompt，所以不动前缀缓存）。开关由 /thinktest 实测得出，见 think.ts。
 * 运行时（meter / 预算 / 借调上下文 / 当前档位）用闭包变量传进节点，
 * 借调嵌套时靠「保存-设置-恢复」保证各自读各自的计量。
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { AIMessage, HumanMessage, SystemMessage, ToolMessage, isAIMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { END, START, StateGraph, Annotation, messagesStateReducer } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { ChatDeepSeek } from '@langchain/deepseek';

import { BudgetExceeded, exceedsBudget, isBudgetExceeded, tokenSpent } from './budget.js';
import { compressAt, compressKeep, maxOut, memoryPath, modelName, toolSteps } from './config.js';
import type { Token } from './grant.js';
import { makeTaskId, parseHandoffInput, type HandoffResult } from './handoff.js';
import type { Ledger } from './ledger.js';
import { TokenMeter } from './meter.js';
import { DEFAULT_MODULE, MODULES, AGENTS, DEFAULT_AGENT, getModule, type AgentId, type AgentModule, type ThinkBudget } from './modules.js';
import { STABLE_PREFIX, TAIL_MARK, renderUserContent } from './prompt.js';
import { continueSubagent, runSubagent, type TurnRunner } from './subagent.js';
import { THINK_KWARGS } from './think.js';
import { TOOL_MAP, capabilityOfTool, kindOf, toolsFor } from './capability.js';
import { checkAction, type Action } from './policy.js';

export const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  /** 当前模块 id。工具执行层按它收权 */
  module: Annotation<string>({
    reducer: (_prev: string, next: string) => next,
    default: () => DEFAULT_MODULE,
  }),
});

/**
 * 借调上下文（M2）。delegate 的**执行层**要用的东西 —— 工具本身拿不到，
 * 由会话层（repl / 命令）在 run 时注入。
 */
export interface DelegateContext {
  ledger: Ledger;
  /** 主会话 thread（子 thread 由它派生） */
  thread: string;
  /** 谁在借调（栈顶模块的归属身份） */
  from: AgentId;
  /** 当前身份手上的令牌；没有就 null（A 免令牌，副 agent 会被拒） */
  token: Token | null;
  /** 跑子任务的执行器（通常就是同一个 HiveAgent） */
  runner: TurnRunner;
  /** 取某身份的主模块 */
  moduleOf: (as: AgentId) => AgentModule;
  tail: boolean;
  /** 生成子任务序号 */
  seq: () => number;
  /** 造下一层借调上下文（A→B→C 嵌套）—— 令牌是上一层刚签给 as 的 */
  makeChild: (childToken: Token, childThread: string, as: AgentId) => DelegateContext;
}

export interface TurnRequest {
  text: string;
  threadId: string;
  module: AgentModule;
  tail: boolean;
  /** v2：这一轮的 token 预算闸门。0 / 不传 = 无闸门 */
  budgetTokens?: number;
  /** v2：借调上下文。不传 = 这一轮里 delegate 不可用 */
  delegate?: DelegateContext;
  /**
   * v3 M2：这一轮以**谁**的身份跑 —— 决定工具集（toolsFor）、网关判据（by）
   * 与账本的 agent 栏。借调子任务传被借调的身份，独立会话传栈顶身份。
   */
  agent: AgentId;
  /** v3 M2：网关判定要落账；没有账本就只回一句话，不留痕 */
  ledger?: Ledger;
  /** v3 M2：子任务的 taskId（policy 行跟着它走，便于对账） */
  taskId?: string;
}

export interface TurnResult {
  /** 模型这次说出来的可见文本 */
  text: string;
  /** 实际发出去的那条用户消息（含角色片），/anatomy 用 */
  sentContent: string;
  meter: TokenMeter;
  /** v2：这一轮是否被预算闸门熔断（模型没再被调用） */
  budgetHit: boolean;
  /** v3 M2：本轮被能力网关拒了几次（footer 的「拒 N」用） */
  denied: number;
  /** v3 M2.5：本轮执行了几批工具调用（到上限就停下，见 afterTools） */
  steps: number;
  /** v3 M2.5：本轮发送前压掉了多少条旧消息（0 = 没压） */
  compacted: number;
}

export interface AgentOptions {
  model?: string;
  memoryPath?: string;
  /** 注入的模型实例 —— 测试用假模型，生产线不传。传了则三档共用它、盖过 model 名 */
  chat?: BaseChatModel;
}

/** 一轮的运行时：计量器 + 预算上限 + 借调上下文 + 当前思考档 + 身份（v3 M2） */
interface GraphRuntime {
  meter: TokenMeter | null;
  budgetTokens: number;
  delegate: DelegateContext | null;
  think: ThinkBudget;
  /** v3 M2：这一轮是谁 —— 选哪套绑定好的模型（工具 schema 按身份不同） */
  agent: AgentId;
  /** v3 M2：判罚落账。null = 不落痕（测试里传假 runner 时常见） */
  ledger: Ledger | null;
  threadId: string;
  taskId?: string;
  /** v3 M2：本轮被拒次数 */
  denied: number;
  /** v3 M2.5：本轮已执行几批工具（护栏） */
  steps: number;
  /** v3 M2.5：本轮压缩丢掉了几条旧消息（累计） */
  compacted: number;
  /**
   * v3 M2.5：**上一轮**的入 token —— 压缩的尺子。
   * 不能用 `meter.inTok`：那是本轮的计量器，每轮第一次 callModel 时它还是 0。
   */
  prevInTok: number;
}

/** bindTools 之后的模型不再是 BaseChatModel 而是 Runnable，单独取个名 */
type BoundModel = ReturnType<NonNullable<BaseChatModel['bindTools']>>;

/** 建一个带思考档位的模型。档位映射见 think.ts（由 /thinktest 实测得出） */
function buildModel(modelId: string, think: ThinkBudget): ChatDeepSeek {
  const cap = maxOut();
  const kwargs = THINK_KWARGS[think];
  return new ChatDeepSeek({
    model: modelId,
    temperature: 0,
    maxRetries: 2,
    ...(cap ? { maxTokens: cap } : {}),
    ...(Object.keys(kwargs).length ? { modelKwargs: kwargs } : {}),
  });
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** 借调结果的统一话术（首跑与续跑共用） */
function formatDelegateResult(res: HandoffResult, to: AgentId, budget: number): string {
  if (!res.ok) return `ERROR: 借调 ${to} 未通过 —— ${res.notes ?? '（无说明）'}`;
  if (res.budgetHit) {
    // 明确告诉上层「是预算不够、不是任务失败」，让它加大预算重试（真机实测过这个坑）
    return `[${to}·熔断 ${res.tokens}/${budget} token] 子任务预算不足被熔断 —— 请加大 budgetTokens 再试。`;
  }
  return `[${to} ${res.tokens} token] ${res.output || '（无可见输出）'}`;
}

/**
 * delegate 的执行层接管。到这里说明白名单已放行（当前身份能借调），
 * 剩下的交给 runSubagent / continueSubagent —— 它们再过令牌与预算。
 *
 * v3 M3：args.resume 存在 = 续跑。thread 从 handoffs 记录里取，不重新派生；
 * 归属检查在这里先做一遍（执行核里还有一遍，双保险，且这里能给出更具体的话）。
 */
async function handleDelegate(args: unknown, runtime: GraphRuntime): Promise<string> {
  const ctx = runtime.delegate;
  if (!ctx) return 'ERROR: 当前没有借调上下文（delegate 只能在会话里用）';

  const a = asObj(args);

  // ── v3 M3：续跑 ───────────────────────────────────────────
  const resume = typeof a['resume'] === 'string' ? a['resume'].trim() : '';
  if (resume) {
    const rec = ctx.ledger.findHandoff(resume);
    if (!rec) return `ERROR: 找不到交接 ${resume} —— taskId 见 /handoffs`;
    if (rec.from !== ctx.from) {
      return `ERROR: ${ctx.from} 不能续 ${rec.from} 发起的子会话 ${resume}`;
    }
    if (!rec.thread) return `ERROR: 交接 ${resume} 没有 thread（M3 之前的记录），无法续跑`;
    const asked = typeof a['to'] === 'string' ? a['to'].trim().toUpperCase() : '';
    if (asked && asked !== rec.to) return `ERROR: 续跑目标必须还是 ${rec.to}（不能换人）`;

    const text = typeof a['goal'] === 'string' ? a['goal'].trim() : '';
    if (!text) return 'ERROR: 续跑要一句话追问（放在 goal 里）';
    const budget = Number(a['budgetTokens']);
    if (!Number.isFinite(budget) || budget < 0 || !Number.isInteger(budget)) {
      return 'ERROR: 续跑也要给 budgetTokens（非负整数）';
    }

    const to = rec.to as AgentId;
    const res = await continueSubagent({
      as: to,
      from: ctx.from,
      owner: rec.from as AgentId,
      token: ctx.token,
      thread: rec.thread,
      taskId: resume,
      text,
      budgetTokens: budget,
      deps: {
        runner: ctx.runner,
        ledger: ctx.ledger,
        module: ctx.moduleOf(to),
        tail: ctx.tail,
        makeChildDelegate: (childToken, childThread) => ctx.makeChild(childToken, childThread, to),
      },
    });
    return formatDelegateResult(res, to, budget);
  }

  // ── 首跑 ─────────────────────────────────────────────────
  const parsed = parseHandoffInput({
    taskId: makeTaskId(ctx.seq()),
    from: ctx.from,
    to: a['to'],
    goal: a['goal'],
    slice: a['slice'],
    expect: a['expect'],
    budgetTokens: a['budgetTokens'],
  });
  if (!parsed.ok) return `ERROR: 交接参数不合法 —— ${parsed.reason}`;

  const input = parsed.value;
  const res = await runSubagent({
    as: input.to,
    from: ctx.from,
    input,
    token: ctx.token,
    thread: ctx.thread,
    deps: {
      runner: ctx.runner,
      ledger: ctx.ledger,
      module: ctx.moduleOf(input.to),
      tail: ctx.tail,
      // 子任务里还能再借调（A→B→C）：把同一套 makeChild 递归传下去
      makeChildDelegate: (childToken, childThread) => ctx.makeChild(childToken, childThread, input.to),
    },
  });

  return formatDelegateResult(res, input.to, input.budgetTokens);
}

/** 压缩后那条摘要消息的开头 —— 也用来识别「这条已经是摘要了」，别把摘要再摘要一遍 */
export const SUMMARY_HEAD = '[已压缩的对话要点]';

const SUMMARY_LINE_CHARS = 60;
const SUMMARY_MAX_LINES = 20;

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function messageText(m: BaseMessage): string {
  const c = m.content as unknown;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((p) =>
        typeof p === 'string' ? p : ((p as { text?: unknown }).text as string | undefined) ?? '',
      )
      .join('');
  }
  return '';
}

/** 用户消息末尾挂着角色片（【模块:x】…）—— 摘要里把它剥掉，只留本人说的话 */
function stripTailMark(text: string): string {
  const at = text.indexOf(TAIL_MARK);
  return at === -1 ? text : text.slice(0, at);
}

/**
 * 把被丢掉的那些消息压成一条人话（**零 API** —— 不调模型，纯启发式）。
 * 只取每轮的问句与答句首 60 字：粗，但免费，而且**确定性**（同样的输入永远同样的输出）。
 */
export function renderSummary(dropped: BaseMessage[]): string {
  const lines: string[] = [];
  let pendingQ = '';

  for (const m of dropped) {
    const type = m.getType();
    if (type === 'human') {
      const text = stripTailMark(messageText(m)).trim();
      if (!text || text.startsWith(SUMMARY_HEAD)) continue;
      pendingQ = clip(text, SUMMARY_LINE_CHARS);
      continue;
    }
    if (type === 'ai' && pendingQ) {
      const ans = clip(messageText(m), SUMMARY_LINE_CHARS);
      lines.push(ans ? `· 问「${pendingQ}」→ 答「${ans}」` : `· 问「${pendingQ}」`);
      pendingQ = '';
    }
  }
  if (pendingQ) lines.push(`· 问「${pendingQ}」（未答完）`);

  const shown = lines.slice(0, SUMMARY_MAX_LINES);
  const rest = lines.length - shown.length;
  return [
    `${SUMMARY_HEAD}（压掉 ${dropped.length} 条消息）`,
    ...shown,
    ...(rest > 0 ? [`…（其余 ${rest} 轮省略）`] : []),
  ].join('\n');
}

export interface CompactionResult {
  messages: BaseMessage[];
  dropped: number;
  /** 有压缩时给出来（也便于测试断言"摘要稳定"） */
  summary: string | null;
}

/**
 * 发送前的压缩（v3 M2.5 §3）。三条自律：
 *   · **只在超阈值时压**：尺子是上一轮的真实 inTok（免费且准确，不做额外估算）
 *   · **切点对齐到 human 边界**：每轮以用户消息开头，从那里切才不会把 `tool_calls`
 *     和它的回包拆散（拆散了模型侧直接报错）
 *   · **不动 state / checkpoint**：只有发出去的那一份被裁，`/turn`、续会话看到的仍是全量
 *
 * ⚠ 代价要说清：压缩改的是 prompt **中段**，缓存按前缀算 —— 压一次就是一次全量重算。
 * 所以它必须「攒够了做一次」，不能每轮微调；摘要文本也因此必须稳定。
 */
export function compactMessages(
  messages: BaseMessage[],
  opts: { at: number; keep: number; lastInTok: number },
): CompactionResult {
  const untouched: CompactionResult = { messages, dropped: 0, summary: null };
  if (opts.at <= 0 || opts.keep <= 0) return untouched;
  if (opts.lastInTok < opts.at) return untouched;
  if (messages.length <= opts.keep) return untouched;

  let cut = Math.max(messages.length - opts.keep, 0);
  while (cut < messages.length && messages[cut]!.getType() !== 'human') cut += 1;
  if (cut <= 0 || cut >= messages.length) return untouched;

  const dropped = messages.slice(0, cut);
  const summary = renderSummary(dropped);
  return { messages: [new HumanMessage(summary), ...messages.slice(cut)], dropped: dropped.length, summary };
}

/** 工具调用 → 网关要看的动作目标 */
function actionTarget(name: string, args: Record<string, unknown>): string {
  const pick = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '');
  switch (name) {
    case 'read_file':
    case 'write_file':
      return pick('path');
    case 'grep':
      return pick('path') || pick('glob') || '.';
    case 'edit_file':
      return pick('path');
    case 'glob':
      return pick('pattern');
    case 'bash':
      return pick('command');
    case 'delegate':
      return pick('to');
    default:
      return '';
  }
}

/**
 * 能力网关的那道门（docs/V3-M2-DESIGN.md §2.5 第 3 步）。
 * 返回 null = 放行；返回字符串 = 给模型的拒绝文本（**且已落账**）。
 * 没有 kind 的工具（calculator）无副作用，不进网关。
 *
 * 落账是「放行与拒绝都记」—— 放行的量等于工具调用次数，可控；
 * 而所有 token 统计都按 tag='turn' 过滤，所以 policy 行不污染账单。
 */
function gateToolCall(
  name: string,
  raw: unknown,
  agent: AgentId,
  runtime: GraphRuntime,
): string | null {
  const kind = kindOf(name);
  const capability = capabilityOfTool(name);
  if (!kind || !capability) return null;

  const action: Action = {
    kind,
    target: actionTarget(name, asObj(raw)),
    by: agent,
    capability,
    tool: name,
    threadId: runtime.threadId,
    ...(runtime.taskId ? { taskId: runtime.taskId } : {}),
  };
  const v = checkAction(action);

  runtime.ledger?.insertPolicy({
    capability,
    agent,
    target: action.target,
    verdict: v.code,
    reason: v.reason,
    threadId: runtime.threadId,
    ...(runtime.taskId ? { taskId: runtime.taskId } : {}),
  });

  if (v.allow) return null;
  runtime.denied += 1;
  return `ERROR: 被策略拒绝（${v.reason}）`;
}

function buildGraph(models: Record<ThinkBudget, BaseChatModel>, checkpointer: BaseCheckpointSaver) {
  // 当前这一轮的运行时。一次只有一个活跃 run（REPL 串行），
  // 借调嵌套时用「保存-设置-恢复」保证各自读各自的计量。
  let runtime: GraphRuntime = {
    meter: null,
    budgetTokens: 0,
    delegate: null,
    think: 'low',
    agent: DEFAULT_AGENT,
    ledger: null,
    threadId: '',
    denied: 0,
    steps: 0,
    compacted: 0,
    prevInTok: 0,
  };

  // v3 M2：**每个 agent 一套工具**（V3-PLAN §3.1）—— 缓存单位从「全局一套」
  // 改成「每个 agent 一套」，各 agent 各自冷启动一次，互不影响。
  // 工具顺序由 capability.ts 的注册表定死，这里不能排序、不能重排，
  // 否则前缀字节一变就是一次缓存作废。
  // think 档走 modelKwargs（请求体，不进 prompt），所以同一 agent 的三档共用一份缓存。
  const bound = {} as Record<AgentId, Record<ThinkBudget, BoundModel>>;
  for (const id of Object.keys(AGENTS) as AgentId[]) {
    const tools = toolsFor(id);
    bound[id] = {
      off: models.off.bindTools!(tools),
      low: models.low.bindTools!(tools),
      high: models.high.bindTools!(tools),
    };
  }

  const callModel = async (state: typeof StateAnnotation.State) => {
    // §6：闸门在模型调用之前。超了就不发请求，直接熔断这一轮
    if (runtime.meter && exceedsBudget(runtime.meter, runtime.budgetTokens)) {
      throw new BudgetExceeded(tokenSpent(runtime.meter), runtime.budgetTokens);
    }
    // v3 M2.5：发送前压缩。尺子是**上一轮的真实 inTok**（免费且准确，不做估算）。
    // 只裁要发出去的那一份 —— state / checkpoint 一个字节不改（与 SYSTEM 的处理方式一致）。
    const packed = compactMessages(state.messages, {
      at: compressAt(),
      keep: compressKeep(),
      lastInTok: runtime.prevInTok,
    });
    if (packed.dropped > 0) runtime.compacted += packed.dropped;

    const messages = [new SystemMessage(STABLE_PREFIX), ...packed.messages];
    const reply = await bound[runtime.agent][runtime.think].invoke(messages);
    return { messages: [reply] };
  };

  const callTools = async (state: typeof StateAnnotation.State) => {
    const last = state.messages[state.messages.length - 1];
    const agent = runtime.agent;
    // v3 M2：判据是**身份**的 capability 装配，不再是模块的白名单
    const allowed = new Set(toolsFor(agent).map((t) => t.name));
    const out: ToolMessage[] = [];
    const calls = isAIMessage(last as BaseMessage) ? ((last as AIMessage).tool_calls ?? []) : [];

    // v3 M2.5：这里只计数 —— 拦在「tools 之后回不回 agent」那条条件边（见 afterTools）。
    // 回一句「到上限了」是不够的：模型完全可以无视它再要一次，那就成了无限循环。
    // 计数与「限不限」无关：0 = 不限时也数，只是不拦。
    runtime.steps += 1;

    for (const call of calls) {
      const name = call.name;
      const fn = TOOL_MAP[name] as
        | { invoke: (input: unknown) => Promise<unknown> }
        | undefined;
      let result: string;
      if (!fn) {
        result = `ERROR: 没有这个工具 ${name}`;
      } else if (!allowed.has(name)) {
        // 第一道门：这个身份有没有这件工具
        result = `ERROR: 身份 ${agent} 没装工具 ${name}（/caps 看各身份装了什么）`;
      } else {
        // 第二道门：能力网关 —— 这一次准不准（拒绝会落账，且不进模型）
        const blocked = gateToolCall(name, call.args, agent, runtime);
        if (blocked) {
          result = blocked;
        } else if (name === 'delegate') {
          // 借调走执行层：先令牌 + 预算，再由 runSubagent 跑
          result = await handleDelegate(call.args, runtime);
        } else {
          try {
            result = String(await fn.invoke(call.args));
          } catch (e) {
            result = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
      }
      out.push(new ToolMessage({ content: result, tool_call_id: call.id ?? '' }));
    }
    return { messages: out };
  };

  const route = (state: typeof StateAnnotation.State): 'tools' | typeof END => {
    const last = state.messages[state.messages.length - 1];
    if (isAIMessage(last as BaseMessage) && ((last as AIMessage).tool_calls?.length ?? 0) > 0) {
      return 'tools';
    }
    return END;
  };

  /**
   * v3 M2.5：工具批次到顶就**结束本轮**，不再让模型自由发挥。
   * 这一步同时满足两个约束：既不会无限循环，又保证历史最后一条是 ToolMessage
   * 而不是带 tool_calls 的 AIMessage（否则下一次请求会被模型侧拒）。
   */
  const afterTools = (): 'agent' | typeof END => {
    const max = toolSteps();
    return max > 0 && runtime.steps >= max ? END : 'agent';
  };

  const app = new StateGraph(StateAnnotation)
    .addNode('agent', callModel)
    .addNode('tools', callTools)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', route, { tools: 'tools', [END]: END })
    .addConditionalEdges('tools', afterTools, { agent: 'agent', [END]: END })
    .compile({ checkpointer });

  return {
    app,
    setRuntime: (r: GraphRuntime): void => {
      runtime = r;
    },
    getRuntime: (): GraphRuntime => runtime,
  };
}

export class HiveAgent {
  readonly modelId: string;
  readonly memoryFile: string;

  /**
   * v3 M2.5：按 thread 记住**上一轮的入 token** —— 压缩的尺子。
   * 不能拿本轮 meter 当尺子（它是本轮的，第一次调用时是 0）。
   */
  private readonly prevInTok = new Map<string, number>();

  private readonly graph: ReturnType<typeof buildGraph>;

  constructor(opts: AgentOptions = {}) {
    this.modelId = opts.model ?? modelName();
    this.memoryFile = resolve(opts.memoryPath ?? memoryPath());
    mkdirSync(dirname(this.memoryFile), { recursive: true });

    const checkpointer = SqliteSaver.fromConnString(this.memoryFile);
    // fromConnString 是否建表随版本而异；能调就调，重复建表无害
    const maybeSetup = (checkpointer as unknown as { setup?: () => void }).setup;
    if (typeof maybeSetup === 'function') {
      try {
        maybeSetup.call(checkpointer);
      } catch {
        /* 已经建好了 */
      }
    }

    // 思考档 → 模型实例。注入假模型时三档共用它（假模型忽略 modelKwargs）
    const models: Record<ThinkBudget, BaseChatModel> = opts.chat
      ? { off: opts.chat, low: opts.chat, high: opts.chat }
      : {
          off: buildModel(this.modelId, 'off'),
          low: buildModel(this.modelId, 'low'),
          high: buildModel(this.modelId, 'high'),
        };
    this.graph = buildGraph(models, checkpointer);
  }

  /**
   * 跑一轮，边跑边把可见文本喂给 onChunk。
   * 计量挂在 callbacks 上，工具轮（两次调用）会自然累加。
   * 带 budgetTokens 时，超过预算的那次 callModel 直接熔断，本轮以 budgetHit 收尾。
   * 带 delegate 时，模型调 delegate 会经执行层接手（令牌 + 预算）。
   * 思考档由 req.module.think 决定（一级分级）。
   */
  async run(req: TurnRequest, onChunk?: (piece: string) => void): Promise<TurnResult> {
    const meter = new TokenMeter({ model: this.modelId });
    const sentContent = renderUserContent(req.text, req.module, { tail: req.tail });

    const saved = this.graph.getRuntime();
    // 持有本轮 runtime 的引用：finally 会把 graph 上的 runtime 恢复成上一轮，
    // 靠 getRuntime() 事后读会读到旧值（denied 永远是 0）—— 所以直接读这个对象
    const rt = {
      meter,
      budgetTokens: req.budgetTokens ?? 0,
      delegate: req.delegate ?? null,
      think: req.module.think,
      agent: req.agent,
      ledger: req.ledger ?? null,
      threadId: req.threadId,
      ...(req.taskId ? { taskId: req.taskId } : {}),
      denied: 0,
      steps: 0,
      compacted: 0,
      prevInTok: this.prevInTok.get(req.threadId) ?? 0,
    };
    this.graph.setRuntime(rt);

    // ⚠ LangGraph 自己的递归上限默认 25，比我们的步数护栏更早触发 ——
    // 一批工具 = 「agent + tools」两次跳转，所以必须把上限抬到 2×步数 + 余量，
    // 否则先抛的是 GraphRecursionError（那是报错，不是我们想要的「安静停下」）。
    const steps = toolSteps();
    const config = {
      configurable: { thread_id: req.threadId },
      callbacks: [meter],
      streamMode: 'messages' as const,
      recursionLimit: steps > 0 ? steps * 2 + 6 : 1000,
    };

    let text = '';
    try {
      const stream = (await this.graph.app.stream(
        { messages: [new HumanMessage(sentContent)], module: req.module.id },
        config,
      )) as AsyncIterable<[BaseMessage, Record<string, unknown>]>;

      for await (const [chunk, meta] of stream) {
        if (meta?.['langgraph_node'] !== 'agent') continue;
        const piece = contentToText(chunk.content);
        if (!piece) continue;
        text += piece;
        onChunk?.(piece);
      }
    } catch (e) {
      if (isBudgetExceeded(e)) {
        return {
          text,
          sentContent,
          meter,
          budgetHit: true,
          denied: rt.denied,
          steps: rt.steps,
          compacted: rt.compacted,
        };
      }
      throw e;
    } finally {
      // 这一轮的入 token 就是下一轮的尺子（在恢复旧 runtime 之前先记下）
      this.prevInTok.set(req.threadId, meter.inTok);
      this.graph.setRuntime(saved);
    }

    return {
      text,
      sentContent,
      meter,
      budgetHit: false,
      denied: rt.denied,
      steps: rt.steps,
      compacted: rt.compacted,
    };
  }

  async history(threadId: string): Promise<BaseMessage[]> {
    const snap = await this.graph.app.getState({ configurable: { thread_id: threadId } });
    const values = snap?.values as { messages?: BaseMessage[] } | undefined;
    return values?.messages ?? [];
  }

  async checkpoints(threadId: string, limit = 5): Promise<Array<{ step: number; next: string; id: string }>> {
    const out: Array<{ step: number; next: string; id: string }> = [];
    const iter = this.graph.app.getStateHistory({ configurable: { thread_id: threadId } });
    for await (const snap of iter as AsyncIterable<{
      next?: string[];
      metadata?: { step?: number };
      config?: { configurable?: { checkpoint_id?: string } };
    }>) {
      out.push({
        step: snap.metadata?.step ?? -1,
        next: snap.next?.[0] ?? '结束',
        id: snap.config?.configurable?.checkpoint_id ?? '',
      });
      if (out.length >= limit) break;
    }
    return out;
  }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const t = (part as { text?: unknown }).text;
        return typeof t === 'string' ? t : '';
      })
      .join('');
  }
  return '';
}
