/**
 * REPL。三条规矩：
 *   · 命令以 / 开头，非命令输入直接发给模型（尾部挂当前模块角色片）
 *   · 回答期间 pause 输入，回答完把底部状态行补齐，再恢复提示符
 *   · 任何异常都不该把会话弄死
 *
 * v2：每一轮都带上**借调上下文**（DelegateContext）—— 模型在本轮里调 delegate
 * 时，执行层才有东西可查（令牌、账本、子执行器）。当前身份由模块栈顶决定。
 * 借调上下文可递归：A 借调 B 时，B 的子任务里拿到的是同一套 makeChild，
 * 于是 A→B→C 的嵌套在子任务里也能继续。
 *
 * v3：`opts.as` 让任一个 agent 独立启动（`hive --as B`）—— 栈底直接是它的主模块，
 * thread 挂在 `solo#<id>` 上（可续）。见 docs/V3-PLAN.md §2。
 */
import { createInterface, type Interface } from 'node:readline';

import { APP_NAME, VERSION, currentBand, ledgerPath, memoryPath, toolSteps, turnBudget } from './core/config.js';
import { HiveAgent, type DelegateContext, type HiveAgent as AgentType } from './core/agent.js';
import { classifyError } from './core/errors.js';
import type { Token } from './core/grant.js';
import { soloThread } from './core/handoff.js';
import { Ledger } from './core/ledger.js';
import { SessionTally } from './core/meter.js';
import { AGENTS, DEFAULT_MODULE, getAgent, getModule, type AgentId } from './core/modules.js';
import { currentAgent, currentModuleId, newReplState, newReplStateFor, type ReplState } from './core/session.js';
import { findCommand, footerInput, knownCommandNames, type Ctx } from './commands.js';
import { bold, cyan, dim, fmtUsd, gray, red } from './ui/format.js';
import { renderFooter } from './ui/footer.js';

export interface ContextOptions {
  agent?: HiveAgent;
  ledger?: Ledger;
  thread?: string;
  /** v3：以该身份独立启动（栈底放它的主模块，thread 默认 solo#<id>） */
  as?: AgentId;
}

export interface BuiltContext {
  ctx: Ctx;
  agent: AgentType;
  ledger: Ledger;
  session: SessionTally;
  state: ReplState;
}

export function buildContext(opts: ContextOptions = {}): BuiltContext {
  const agent = opts.agent ?? new HiveAgent();
  const ledger = opts.ledger ?? new Ledger();
  const opened = ledger.open();
  const session = new SessionTally();
  const state =
    opts.as !== undefined
      ? newReplStateFor(opts.thread ?? soloThread(opts.as), opts.as)
      : newReplState(opts.thread ?? 'main');
  const ctx: Ctx = {
    agent,
    ledger,
    session,
    state,
    out: (s = '') => process.stdout.write(`${s}\n`),
  };
  if (!opened) {
    ctx.out(red(`[账本打不开 ${ledgerPath()} —— 本次不落盘，对话照常]`));
  }
  return { ctx, agent, ledger, session, state };
}

export function printFooter(ctx: Ctx): void {
  if (!ctx.state.footer) return;
  process.stdout.write(`${renderFooter(footerInput(ctx))}\n`);
}

let delegateSeq = 0;

/**
 * 借调上下文 —— 会话层把执行层需要的东西装好。
 * 身份取模块栈顶；令牌：A 免令牌（它是签发者），副 agent 取 A 签给它的有效令牌。
 * `makeChild` 递归造下一层，令牌换成上一层刚签给子 agent 的那张 → 栈式借调。
 */
export function makeDelegateContext(ctx: Ctx): DelegateContext {
  const moduleOf = (as: Parameters<DelegateContext['moduleOf']>[0]): ReturnType<DelegateContext['moduleOf']> =>
    getModule(getAgent(as)?.home ?? DEFAULT_MODULE) ?? getModule(DEFAULT_MODULE)!;
  const seq = (): number => {
    delegateSeq += 1;
    return delegateSeq;
  };

  const make = (from: DelegateContext['from'], token: Token | null, thread: string): DelegateContext => ({
    ledger: ctx.ledger,
    thread,
    from,
    token,
    runner: ctx.agent,
    moduleOf,
    tail: ctx.state.tail,
    seq,
    makeChild: (childToken, childThread, as) => make(as, childToken, childThread),
  });

  const from = currentAgent(ctx.state);
  return make(from, ctx.ledger.liveTokens(from)[0] ?? null, ctx.state.thread);
}

const EXIT_WORDS = new Set(['/exit', 'exit', 'quit', 'q', '退出', '再见']);

function banner(ctx: Ctx): void {
  const band = currentBand() === 'peak' ? '峰时（全价）' : '谷时（半价）';
  const t = ctx.ledger.totals();
  ctx.out(`${bold(APP_NAME)} ${VERSION} · ${cyan(ctx.agent.modelId)} · ${dim(band)} · thread=${ctx.state.thread}`);
  ctx.out(
    dim(
      `账本 ${ctx.ledger.path}` +
        (t && t.rows ? ` · 历史 ${t.rows} 行 · ${fmtUsd(t.costUsd)} 起自 ${(ctx.ledger.since() ?? '').slice(0, 10)}` : ' · 空'),
    ),
  );
  ctx.out(
    dim(
      `checkpoint ${memoryPath()} · 模块 ${currentModuleId(ctx.state)} · 身份 ${currentAgent(ctx.state)}` +
        (ctx.state.tail ? ' · 尾部角色片 开' : ' · 尾部角色片 关'),
    ),
  );
  ctx.out(gray('敲 /help 看命令；不是命令的输入会直接发给模型。'));
  ctx.out();
}

/** 一轮真实对话 —— 流式打印、记账、补 footer */
export async function runTurn(ctx: Ctx, text: string, signal?: AbortSignal): Promise<void> {
  // 当前角色 = 栈顶模块。借调中就是被借调的那个 agent
  const mod = getModule(currentModuleId(ctx.state)) ?? getModule('assistant')!;
  process.stdout.write(`\n${bold('助手')} ${dim('>')} `);

  let answer = '';
  try {
    const res = await ctx.agent.run(
      {
        text,
        threadId: ctx.state.thread,
        module: mod,
        tail: ctx.state.tail,
        delegate: makeDelegateContext(ctx),
        // v3 M2：身份决定工具集与网关判据；账本给网关落判罚
        agent: currentAgent(ctx.state),
        ledger: ctx.ledger,
        // v3 M2.5：自己聊天的这条路也上闸门（原先只有借调子任务有）
        budgetTokens: turnBudget(),
        // v4 M4.3：Ctrl+C 中止这一轮
        ...(signal ? { signal } : {}),
      },
      (piece) => {
        process.stdout.write(piece);
      },
    );
    answer = res.text;
    ctx.state.lastTurn = res.meter;
    ctx.state.lastSent = res.sentContent;
    ctx.state.lastDenied = res.denied;
    ctx.session.add(res.meter);
    if (answer === '') process.stdout.write(dim('（这轮没有可见输出，钱都花在思考上了）'));
    process.stdout.write('\n');

    // v3 M2.5：两道护栏触发时都说清「为什么停、怎么继续」—— 免得看起来像出错
    if (res.budgetHit) {
      process.stdout.write(red(`[本轮熔断：超了 ${turnBudget()} token 上限 —— 说「继续」就接着跑]\n`));
    }
    const maxSteps = toolSteps();
    if (maxSteps > 0 && res.steps >= maxSteps) {
      process.stdout.write(dim(`[本轮工具调用到上限 ${maxSteps} 批，已停下 —— 说「继续」就接着跑]\n`));
    }
    if (res.compacted) {
      process.stdout.write(
        dim(`[历史已压缩：丢掉 ${res.compacted} 条旧消息 —— 这一次前缀要重算]\n`),
      );
    }

    ctx.ledger.insert({
      kind: 'turn',
      threadId: ctx.state.thread,
      module: mod.id,
      calls: res.meter.calls,
      inTok: res.meter.inTok,
      cacheHit: res.meter.cacheHit,
      outTok: res.meter.outTok,
      reasoning: res.meter.reasoning,
      costUsd: res.meter.cost(),
      userChars: text.length,
      userHead: text,
      outHead: answer,
      styleOn: ctx.state.tail ? 1 : 0,
      band: res.meter.band,
      agent: currentAgent(ctx.state),
    });
  } catch (e) {
    process.stdout.write('\n');
    const c = classifyError(e);
    ctx.out(red(`  ── [${c.title}] ${c.message}`));
    if (c.hint) ctx.out(dim(`     ${c.hint}`));
  }

  printFooter(ctx);
  process.stdout.write('\n');
}

export async function startRepl(opts: ContextOptions = {}): Promise<void> {
  const { ctx, ledger } = buildContext(opts);
  banner(ctx);

  const rl: Interface = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });

  let activeAbort: AbortController | null = null;

  const onSigint = (): void => {
    // v4 M4.3：跑一轮时，第一下 Ctrl+C 只中止这一轮；空闲时才是退出
    if (activeAbort) {
      process.stdout.write('\n');
      ctx.out(red('[正在中止本轮…]'));
      activeAbort.abort();
      return;
    }
    process.stdout.write('\n');
    ctx.out(gray('再见。'));
    rl.close();
    process.exit(0);
  };

  rl.on('SIGINT', onSigint);
  // 非 TTY（管道 / 脚本）下 readline 收不到 OS 信号，用进程级兜底
  process.on('SIGINT', onSigint);

  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (EXIT_WORDS.has(lower)) break;

    // 少了斜杠的命令自动补上，否则它会变成一条真·付费消息
    let text = raw;
    if (!raw.startsWith('/')) {
      const first = raw.split(/\s+/)[0]?.toLowerCase() ?? '';
      if (knownCommandNames().includes(`/${first}`)) {
        text = `/${raw}`;
        ctx.out(dim(`[自动补上斜杠：/${first}]`));
      }
    }

    if (text.startsWith('/')) {
      const parts = text.split(/\s+/);
      const name = (parts[0] ?? '').toLowerCase();
      const cmd = findCommand(name);
      if (!cmd) {
        ctx.out(red(`[未知命令 ${name}，没有发给模型 —— 省一次调用]`));
        continue;
      }
      if (cmd.name === '/exit') break;
      try {
        await cmd.run(ctx, parts.slice(1));
      } catch (e) {
        ctx.out(red(`[命令 ${cmd.name} 出错：${e instanceof Error ? e.message : String(e)}]`));
      }
      continue;
    }

    rl.pause();
    const ctl = new AbortController();
    activeAbort = ctl;
    try {
      await runTurn(ctx, text, ctl.signal);
    } finally {
      activeAbort = null;
      rl.resume();
    }
  }

  ledger.close();
  process.off('SIGINT', onSigint);
  ctx.out(gray('再见。'));
}

export { AGENTS, renderFooter };
