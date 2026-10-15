/**
 * REPL。三条规矩：
 *   · 命令以 / 开头，非命令输入直接发给模型（尾部挂当前模块角色片）
 *   · 回答期间 pause 输入，回答完把底部状态行补齐，再恢复提示符
 *   · 任何异常都不该把会话弄死
 */
import { createInterface, type Interface } from 'node:readline';

import { APP_NAME, VERSION, currentBand, ledgerPath, memoryPath } from './core/config.js';
import { HiveAgent, type HiveAgent as AgentType } from './core/agent.js';
import { Ledger } from './core/ledger.js';
import { SessionTally } from './core/meter.js';
import { getModule } from './core/modules.js';
import { newReplState, type ReplState } from './core/session.js';
import { findCommand, footerInput, knownCommandNames, type Ctx } from './commands.js';
import { bold, cyan, dim, fmtUsd, gray, red } from './ui/format.js';
import { renderFooter } from './ui/footer.js';

export interface ContextOptions {
  agent?: HiveAgent;
  ledger?: Ledger;
  thread?: string;
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
  const state = newReplState(opts.thread ?? 'main');
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
      `checkpoint ${memoryPath()} · 模块 ${ctx.state.moduleId}` +
        (ctx.state.tail ? ' · 尾部角色片 开' : ' · 尾部角色片 关'),
    ),
  );
  ctx.out(gray('敲 /help 看命令；不是命令的输入会直接发给模型。'));
  ctx.out();
}

/** 一轮真实对话 —— 流式打印、记账、补 footer */
export async function runTurn(ctx: Ctx, text: string): Promise<void> {
  const mod = getModule(ctx.state.moduleId) ?? getModule('assistant')!;
  process.stdout.write(`\n${bold('助手')} ${dim('>')} `);

  let answer = '';
  try {
    const res = await ctx.agent.run(
      { text, threadId: ctx.state.thread, module: mod, tail: ctx.state.tail },
      (piece) => {
        process.stdout.write(piece);
      },
    );
    answer = res.text;
    ctx.state.lastTurn = res.meter;
    ctx.state.lastSent = res.sentContent;
    ctx.session.add(res.meter);
    if (answer === '') process.stdout.write(dim('（这轮没有可见输出，钱都花在思考上了）'));
    process.stdout.write('\n');

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
    });
  } catch (e) {
    process.stdout.write('\n');
    ctx.out(red(`  ── [调用失败 ${e instanceof Error ? e.name : 'Error'}: ${e instanceof Error ? e.message : String(e)}] —— 会话还在，可以继续问`));
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

  rl.on('SIGINT', () => {
    process.stdout.write('\n');
    ctx.out(gray('再见。'));
    rl.close();
    process.exit(0);
  });

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
    try {
      await runTurn(ctx, text);
    } finally {
      rl.resume();
    }
  }

  ledger.close();
  ctx.out(gray('再见。'));
}

export { renderFooter };
