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
import { gistFor } from './core/gist.js';
import { knownBalance, knownBalanceAt, knownBalanceCurrency, refreshBalance } from './core/balance.js';
import { emitUi, uiSink } from './core/uievents.js';
import { bold, cyan, dim, fmtUsd, gray, red, stripAnsi } from './ui/format.js';
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
    out: (s = '') => {
      process.stdout.write(`${s}\n`);
      // 对话流视图里，命令输出（/cost 的表格、报错、提示）也要看得见 ——
      // 同一份文本剥掉 ANSI 再发一份，前端当系统消息渲染。
      if (s && uiSink()) emitUi({ t: 'out', text: stripAnsi(s) });
    },
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

/**
 * 底部指标栏的数据 —— 和终端那行 footer 同源（footerInput），
 * 但窗口里要能**分列显示**，所以给结构化字段而不是拼好的字符串。
 * 余额由 balance.ts 异步查（带缓存），这里只取当前已知值。
 */
function emitStats(ctx: Ctx): void {
  if (!uiSink()) return;
  const f = footerInput(ctx);
  const m = f.lastTurn;
  emitUi({
    t: 'stats',
    stats: {
      model: f.model,
      band: f.band,
      cost: m ? m.cost() : 0,
      reasonPct: m && m.cost() ? Math.round((m.reasonCost() / m.cost()) * 100) : 0,
      ctxTok: m ? m.inTok : 0,
      cacheHit: m ? m.cacheHit : 0,
      hitRate: m ? m.hitRate() : 0,
      sessionCost: f.session.costUsd,
      turns: f.session.turns,
      avgCost: f.session.avgCost,
      balance: knownBalance(),
      balanceCurrency: knownBalanceCurrency(),
      balanceAt: knownBalanceAt(),
    },
  });
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
  emitUi({ t: 'turn', text });
  process.stdout.write(`\n${bold('助手')} ${dim('>')} `);

  // 右栏的思考正文在这里攒着：一段思考结束时拿去让模型写一句中文备注。
  // 攒的是全文而不是最后一片 —— 备注要的是这段思考的结论，不是结尾半句话。
  let thinkBuf = '';
  let turnOk = true;

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
        hooks: {
          onThink: (piece) => {
            thinkBuf += piece;
          },
          onThinkEnd: () => {
            const body = thinkBuf;
            thinkBuf = '';
            if (!body) return;
            // 没有事件通道（正常终端）就没有右栏可填 —— 别为一个没人看的备注花钱。
            // `hive --as B` 这类 high 档身份在终端里跑一轮会有多段思考，每段都会触发这里。
            if (!uiSink()) return;
            // 备注是异步的：它回来晚一点右栏就补一行，绝不阻塞对话流
            void gistFor({ thinking: body, task: text }).then((g) =>
              emitUi({ t: 'gist', gist: g.gist, source: g.source }),
            );
          },
        },
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

    // 隐私窗口里的 hive：账本只记 token 用量，正文列写占位符。
    // 普通窗口（不防录屏）不脱敏 —— 那是隐私模式独有的要求。
    const redact = process.env.HIVE_PRIVACY_REDACT === '1';
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
      userHead: redact ? '[privacy]' : text,
      outHead: redact ? '' : answer,
      styleOn: ctx.state.tail ? 1 : 0,
      band: res.meter.band,
      agent: currentAgent(ctx.state),
    });
  } catch (e) {
    turnOk = false;
    process.stdout.write('\n');
    const c = classifyError(e);
    ctx.out(red(`  ── [${c.title}] ${c.message}`));
    if (c.hint) ctx.out(dim(`     ${c.hint}`));
    emitUi({ t: 'note', kind: 'error', text: `${c.title}：${c.message}` });
  }

  // 整段回答交给前端重排 markdown：增量拼出来的列表/代码块在流式时会抖
  if (answer) emitUi({ t: 'say_done', text: answer });
  printFooter(ctx);
  emitStats(ctx);
  emitUi({ t: 'turn_end', ok: turnOk });
  process.stdout.write('\n');
}

export async function startRepl(opts: ContextOptions = {}): Promise<void> {
  const { ctx, ledger } = buildContext(opts);
  // 窗口右栏的开场：模型 / 线程 / 身份，前端据此清空旧的思考流
  emitUi({
    t: 'session',
    model: ctx.agent.modelId,
    thread: ctx.state.thread,
    module: currentModuleId(ctx.state),
  });
  // 余额先查一次（不 await 也不会阻塞开场）—— 指标栏第一轮就有数
  if (uiSink()) void refreshBalance(true);
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
