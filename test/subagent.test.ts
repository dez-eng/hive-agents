/**
 * runSubagent 测试。零 API —— 用假 runner 顶替 HiveAgent。
 *
 * 要证明的事：授权没过就不花钱、不留痕（没成为一次交接）；过了就物理隔离
 * （子 thread）+ 记账 + 留痕 + 扣令牌；跑过但失败/熔断的照样留痕。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { continueSubagent, runSubagent, renderSlice, type TurnRunner } from '../src/core/subagent.js';
import type { TurnRequest, TurnResult } from '../src/core/agent.js';
import { TokenMeter } from '../src/core/meter.js';
import { Ledger } from '../src/core/ledger.js';
import { getModule } from '../src/core/modules.js';
import { BudgetExceeded } from '../src/core/budget.js';
import { DEFAULT_TTL_MS, issueToken, type Token } from '../src/core/grant.js';
import type { HandoffInput } from '../src/core/handoff.js';

const NOW = 1_700_000_000_000;

/** 可控的假 runner：记录收到什么请求，按配置产出结果或抛熔断 */
class FakeRunner implements TurnRunner {
  readonly seen: TurnRequest[] = [];

  constructor(
    private readonly cfg: {
      text?: string;
      inTok?: number;
      outTok?: number;
      budgetHit?: boolean;
      throwBudget?: boolean;
      throwOther?: string;
    } = {},
  ) {}

  async run(req: TurnRequest): Promise<TurnResult> {
    this.seen.push(req);
    if (this.cfg.throwBudget) throw new BudgetExceeded(999, 100);
    if (this.cfg.throwOther) throw new Error(this.cfg.throwOther);
    const meter = new TokenMeter({ model: 'deepseek-flash' });
    meter.absorb({
      calls: 1,
      inTok: this.cfg.inTok ?? 100,
      outTok: this.cfg.outTok ?? 20,
      cacheHit: 0,
      reasoning: 0,
    });
    return {
      text: this.cfg.text ?? '改好了',
      sentContent: req.text,
      meter,
      budgetHit: this.cfg.budgetHit ?? false,
      denied: 0,
      steps: 0,
    };
  }
}

function token(to: 'B' | 'C' | 'D', budget = 500, now = NOW): Token {
  const r = issueToken(to, { budgetTokens: budget, now });
  assert.ok(r.ok);
  return (r as { ok: true; token: Token }).token;
}

function input(over: Partial<HandoffInput> = {}): HandoffInput {
  return {
    taskId: 't001-aaaa',
    from: 'B',
    to: 'C',
    goal: '修掉这一处越界读',
    slice: 'src/core/tools.ts:42 前缀比较要带分隔符',
    expect: '改后的 diff',
    budgetTokens: 200,
    ...over,
  };
}

async function withLedger<T>(fn: (led: Ledger, dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'hive-sub-'));
  const led = new Ledger(join(dir, 't.db'));
  led.open();
  try {
    return await fn(led, dir);
  } finally {
    led.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉，留给系统清 */
    }
  }
}

test('renderSlice 只带结构化三项，没有「原文/历史」入口', () => {
  const s = renderSlice(input());
  assert.ok(s.includes('修掉这一处越界读'));
  assert.ok(s.includes('src/core/tools.ts:42'));
  assert.ok(s.includes('改后的 diff'));
  assert.ok(!/历史|原文/.test(s));
});

test('授权不过：没令牌 → 结构化失败，不进模型也不留痕', async () => {
  await withLedger(async (led) => {
    const runner = new FakeRunner();
    const res = await runSubagent({
      as: 'C',
      from: 'B',
      input: input(),
      token: null,
      thread: 'main',
      deps: { runner, ledger: led, module: getModule('fix')!, tail: true, now: () => NOW },
    });
    assert.equal(res.ok, false);
    assert.equal(res.tokens, 0);
    assert.match(res.notes ?? '', /需要令牌/);
    assert.equal(runner.seen.length, 0, '先挡在花钱之前');
    // 授权没过 = 没成为一次交接：不留 handoffs（否则表里混进「没发生过的交接」）
    assert.equal(led.recentHandoffs(5).length, 0);
  });
});

test('授权不过：身份表里 C 不能借调任何人', async () => {
  await withLedger(async (led) => {
    const runner = new FakeRunner();
    const res = await runSubagent({
      as: 'B',
      from: 'C', // C 的 mayCall 是空的
      input: input({ from: 'C', to: 'B' }),
      token: token('C'),
      thread: 'main',
      deps: { runner, ledger: led, module: getModule('recon')!, tail: true, now: () => NOW },
    });
    assert.equal(res.ok, false);
    assert.match(res.notes ?? '', /无权借调/);
    assert.equal(runner.seen.length, 0);
  });
});

test('授权不过：令牌过期 → 拒', async () => {
  await withLedger(async (led) => {
    const runner = new FakeRunner();
    const res = await runSubagent({
      as: 'C',
      from: 'B',
      input: input(),
      token: token('B'),
      thread: 'main',
      deps: { runner, ledger: led, module: getModule('fix')!, tail: true, now: () => NOW + DEFAULT_TTL_MS + 1 },
    });
    assert.equal(res.ok, false);
    assert.match(res.notes ?? '', /过期/);
    assert.equal(runner.seen.length, 0);
  });
});

test('授权不过：子预算超过令牌余额 → 拒', async () => {
  await withLedger(async (led) => {
    const runner = new FakeRunner();
    const res = await runSubagent({
      as: 'C',
      from: 'B',
      input: input({ budgetTokens: 5000 }), // 令牌只有 500
      token: token('B', 500),
      thread: 'main',
      deps: { runner, ledger: led, module: getModule('fix')!, tail: true, now: () => NOW },
    });
    assert.equal(res.ok, false);
    assert.match(res.notes ?? '', /超预算/);
    assert.equal(runner.seen.length, 0);
  });
});

test('正常借调 B→C：独立 thread、记账带 agent/task、留痕、扣令牌', async () => {
  await withLedger(async (led) => {
    const runner = new FakeRunner({ text: '把比较改成 target.startsWith(ROOT + sep)', inTok: 100, outTok: 20 });
    const tk = token('B', 500);
    led.saveToken(tk);

    const res = await runSubagent({
      as: 'C',
      from: 'B',
      input: input(),
      token: tk,
      thread: 'main',
      deps: { runner, ledger: led, module: getModule('fix')!, tail: true, now: () => NOW },
    });

    assert.equal(res.ok, true);
    assert.equal(res.tokens, 120, '入 100 + 出 20');
    assert.equal(res.budgetHit, false);
    assert.ok((res.output ?? '').includes('startsWith'));

    // 子 thread 与主 thread 物理隔离
    assert.equal(runner.seen.length, 1);
    assert.equal(runner.seen[0]!.threadId, 'main#C#t001-aaaa');
    assert.equal(runner.seen[0]!.module.id, 'fix');

    // 逐轮 token 入账本，agent=C、task_id 带上
    const rows = led.turnsOfTask('t001-aaaa');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.agent, 'C');
    assert.equal(rows[0]!.inTok, 100);
    assert.equal(rows[0]!.budgetTok, 200);

    // 交接记录
    const ho = led.recentHandoffs(1)[0]!;
    assert.equal(ho.from, 'B');
    assert.equal(ho.to, 'C');
    assert.equal(ho.tokens, 120);
    assert.equal(ho.ok, true);
    assert.equal(ho.thread, 'main#C#t001-aaaa', 'v3 M3：thread 落库，续跑靠它');
    assert.equal(res.thread, 'main#C#t001-aaaa', '首跑就把 thread 返回给上层');

    // 令牌扣减
    assert.equal(led.loadToken(tk.id)!.spent, 120);
  });
});

test('熔断：runner 返回 budgetHit → 结果标记熔断，仍记账留痕、仍扣令牌', async () => {
  await withLedger(async (led) => {
    const runner = new FakeRunner({ budgetHit: true, inTok: 800, outTok: 100 });
    const tk = token('B', 500);
    led.saveToken(tk);
    const res = await runSubagent({
      as: 'C',
      from: 'B',
      input: input(),
      token: tk,
      thread: 'main',
      deps: { runner, ledger: led, module: getModule('fix')!, tail: true, now: () => NOW },
    });
    assert.equal(res.budgetHit, true);
    assert.equal(res.ok, true);
    assert.match(res.notes ?? '', /熔断/);
    assert.equal(led.recentHandoffs(1)[0]!.budgetHit, true);
    assert.equal(led.loadToken(tk.id)!.spent, 900, '熔断前花掉的也要扣');
  });
});

test('熔断：runner 直接抛 BudgetExceeded → 也认成熔断（异常路径）', async () => {
  await withLedger(async (led) => {
    const runner = new FakeRunner({ throwBudget: true });
    const res = await runSubagent({
      as: 'C',
      from: 'B',
      input: input(),
      token: token('B'),
      thread: 'main',
      deps: { runner, ledger: led, module: getModule('fix')!, tail: true, now: () => NOW },
    });
    assert.equal(res.budgetHit, true);
    assert.match(res.notes ?? '', /熔断/);
  });
});

test('runner 抛别的错 → ok:false，不误认成熔断', async () => {
  await withLedger(async (led) => {
    const runner = new FakeRunner({ throwOther: '模型抽风' });
    const res = await runSubagent({
      as: 'C',
      from: 'B',
      input: input(),
      token: token('B'),
      thread: 'main',
      deps: { runner, ledger: led, module: getModule('fix')!, tail: true, now: () => NOW },
    });
    assert.equal(res.ok, false);
    assert.equal(res.budgetHit, false);
    assert.match(res.notes ?? '', /模型抽风/);
  });
});

test('嵌套（A→B→C 的前半）：A 借调 B 时自动签发，并把一层借调上下文交给子任务', async () => {
  await withLedger(async (led) => {
    let childSeen: { token: Token; thread: string } | undefined;
    const runner = new FakeRunner({ text: '侦察完了' });
    const res = await runSubagent({
      as: 'B',
      from: 'A', // A 免令牌
      input: input({ from: 'A', to: 'B' }),
      token: null,
      thread: 'main',
      deps: {
        runner,
        ledger: led,
        module: getModule('recon')!,
        tail: true,
        now: () => NOW,
        makeChildDelegate: (childToken, childThread) => {
          childSeen = { token: childToken, thread: childThread };
          return undefined; // 这一层不再往下造
        },
      },
    });

    assert.equal(res.ok, true);
    assert.ok(childSeen, 'A 借调时该给子任务造一层借调上下文');
    assert.equal(childSeen!.token.to, 'B', '令牌签给被借调者 B');
    assert.deepEqual(childSeen!.token.mayCall, ['C', 'D'], 'B 可借调 C/D');
    assert.equal(childSeen!.thread, 'main#B#t001-aaaa', '子上下文挂在 B 的独立 thread 上');
    assert.equal(led.liveTokens('B').length, 1, '自动签发的令牌已落库');
  });
});

// ── v3 M3：可续子会话 ─────────────────────────────────────

test('续跑：复用同一子 thread、发送追加原文、同 task 两行 handoffs、继续扣令牌', async () => {
  await withLedger(async (led) => {
    const runner = new FakeRunner({ text: '第二轮改好了', inTok: 100, outTok: 20 });
    const tk = token('B', 1000);
    led.saveToken(tk);
    const deps = { runner, ledger: led, module: getModule('fix')!, tail: true, now: () => NOW };

    const first = await runSubagent({
      as: 'C',
      from: 'B',
      input: input(),
      token: tk,
      thread: 'main',
      deps,
    });
    assert.equal(first.ok, true);
    assert.equal(first.thread, 'main#C#t001-aaaa');

    const res = await continueSubagent({
      as: 'C',
      from: 'B',
      owner: 'B',
      token: tk,
      thread: first.thread!,
      taskId: 't001-aaaa',
      text: '再看一下第二个调用点',
      budgetTokens: 300,
      deps,
    });

    assert.equal(res.ok, true);
    assert.equal(res.thread, 'main#C#t001-aaaa');
    assert.equal(runner.seen.length, 2);
    assert.equal(runner.seen[1]!.threadId, runner.seen[0]!.threadId, '同一子会话');
    assert.equal(
      runner.seen[1]!.text,
      '再看一下第二个调用点',
      '续跑发的是追问原文，不是重新渲染的 slice',
    );
    assert.equal(runner.seen[1]!.agent, 'C', '身份不变');

    const hos = led.recentHandoffs(2);
    assert.equal(hos.length, 2);
    assert.equal(hos[0]!.goal, '[续跑] 再看一下第二个调用点');
    assert.equal(hos[0]!.thread, 'main#C#t001-aaaa');
    assert.equal(hos[0]!.expect, '续跑');
    assert.equal(led.handoffTotals('t001-aaaa')!.rows, 2, '同一 task 的两轮都留痕');
    assert.equal(led.loadToken(tk.id)!.spent, 240, '首跑 120 + 续跑 120');
  });
});

test('续跑：不是原发起方 → 拒，runner 不跑、不留痕', async () => {
  await withLedger(async (led) => {
    const runner = new FakeRunner();
    const res = await continueSubagent({
      as: 'C',
      from: 'A',
      owner: 'B',
      token: null,
      thread: 'main#C#t001-aaaa',
      taskId: 't001-aaaa',
      text: '我也来问一句',
      budgetTokens: 200,
      deps: { runner, ledger: led, module: getModule('fix')!, tail: true, now: () => NOW },
    });

    assert.equal(res.ok, false);
    assert.match(res.notes ?? '', /不能续/);
    assert.equal(runner.seen.length, 0, '挡在花钱之前');
    assert.equal(led.recentHandoffs(5).length, 0);
  });
});

test('续跑：M3 之前的老记录没有 thread → 明确拒，不猜', async () => {
  await withLedger(async (led) => {
    const runner = new FakeRunner();
    const res = await continueSubagent({
      as: 'C',
      from: 'B',
      owner: 'B',
      token: token('B'),
      thread: '',
      taskId: 'old-1',
      text: '接着上次的',
      budgetTokens: 200,
      deps: { runner, ledger: led, module: getModule('fix')!, tail: true, now: () => NOW },
    });

    assert.equal(res.ok, false);
    assert.match(res.notes ?? '', /没有 thread/);
    assert.equal(runner.seen.length, 0);
  });
});

test('续跑：授权仍走同一道闸 —— 没令牌就拒', async () => {
  await withLedger(async (led) => {
    const runner = new FakeRunner();
    const res = await continueSubagent({
      as: 'C',
      from: 'B',
      owner: 'B',
      token: null,
      thread: 'main#C#t001-aaaa',
      taskId: 't001-aaaa',
      text: '追一句',
      budgetTokens: 200,
      deps: { runner, ledger: led, module: getModule('fix')!, tail: true, now: () => NOW },
    });

    assert.equal(res.ok, false);
    assert.match(res.notes ?? '', /需要令牌/);
    assert.equal(runner.seen.length, 0);
  });
});
