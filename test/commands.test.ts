/**
 * 命令面测试（/grant /handoffs /budget /delegate）。零 API。
 *
 * 用假 runner 顶替 HiveAgent 当子任务执行器；ctx 只留 out 收集输出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findCommand, type Ctx } from '../src/commands.js';
import { Ledger } from '../src/core/ledger.js';
import { SessionTally, TokenMeter } from '../src/core/meter.js';
import { newReplState } from '../src/core/session.js';
import type { HiveAgent, TurnRequest, TurnResult } from '../src/core/agent.js';

class FakeRunner {
  readonly seen: TurnRequest[] = [];
  async run(req: TurnRequest): Promise<TurnResult> {
    this.seen.push(req);
    const meter = new TokenMeter({ model: 'deepseek-flash' });
    meter.absorb({ calls: 1, inTok: 100, outTok: 20, cacheHit: 0, reasoning: 0 });
    return { text: '子任务结论：已修', sentContent: req.text, meter, budgetHit: false, denied: 0, steps: 0 };
  }
}

function makeCtx(led: Ledger, runner: FakeRunner, stack: string[] = ['assistant']) {
  const lines: string[] = [];
  const state = newReplState('main');
  state.stack = stack;
  const ctx: Ctx = {
    agent: runner as unknown as HiveAgent,
    ledger: led,
    session: new SessionTally(),
    state,
    out: (s = '') => {
      lines.push(s);
    },
  };
  return { ctx, lines, runner };
}

async function withLedger<T>(fn: (led: Ledger) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'hive-cmd-'));
  const led = new Ledger(join(dir, 't.db'));
  led.open();
  try {
    return await fn(led);
  } finally {
    led.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
}

test('/grant 签发令牌并落库，可借调范围来自身份表', async () => {
  await withLedger(async (led) => {
    const { ctx, lines } = makeCtx(led, new FakeRunner());
    await findCommand('/grant')!.run(ctx, ['B', '500']);
    const tok = led.liveTokens('B')[0];
    assert.ok(tok, '令牌该落库');
    assert.equal(tok!.budgetTokens, 500);
    assert.deepEqual(tok!.mayCall, ['C', 'D']);
    assert.ok(lines.join('\n').includes('已签发'));
  });
});

test('/grant 不签给 A，也不接受非法预算', async () => {
  await withLedger(async (led) => {
    const { ctx, lines } = makeCtx(led, new FakeRunner());
    await findCommand('/grant')!.run(ctx, ['A', '500']);
    assert.equal(led.liveTokens().length, 0);
    assert.ok(lines.join('\n').includes('签给谁'));

    lines.length = 0;
    await findCommand('/grant')!.run(ctx, ['B', 'abc']);
    assert.equal(led.liveTokens().length, 0);
    assert.ok(lines.join('\n').includes('预算'));
  });
});

test('/delegate：A 免令牌借调 C，子任务跑、handoffs 落库', async () => {
  await withLedger(async (led) => {
    const { ctx, lines, runner } = makeCtx(led, new FakeRunner(), ['assistant']);
    await findCommand('/delegate')!.run(ctx, ['C', '修掉越界读']);

    assert.equal(runner.seen.length, 1, '子任务跑了');
    assert.equal(runner.seen[0]!.module.id, 'fix');
    assert.ok(runner.seen[0]!.threadId.startsWith('main#C#'), '独立 thread');

    const ho = led.recentHandoffs(1)[0]!;
    assert.equal(ho.from, 'A');
    assert.equal(ho.to, 'C');
    assert.equal(ho.ok, true);
    assert.ok(lines.join('\n').includes('完成'));
  });
});

test('/delegate 拒绝非法目标与空目标', async () => {
  await withLedger(async (led) => {
    const { ctx, lines, runner } = makeCtx(led, new FakeRunner());
    await findCommand('/delegate')!.run(ctx, ['X', '干嘛']);
    assert.equal(runner.seen.length, 0);
    assert.ok(lines.join('\n').includes('交给谁'));

    lines.length = 0;
    await findCommand('/delegate')!.run(ctx, ['C']);
    assert.ok(lines.join('\n').includes('用法'));
  });
});

test('/delegate --continue：复用同一子会话，task 不变', async () => {
  await withLedger(async (led) => {
    const { ctx, lines, runner } = makeCtx(led, new FakeRunner(), ['assistant']);
    await findCommand('/delegate')!.run(ctx, ['C', '修掉越界读']);
    const first = led.recentHandoffs(1)[0]!;
    assert.ok(first.thread, '首跑落 thread');

    lines.length = 0;
    await findCommand('/delegate')!.run(ctx, ['--continue', first.taskId, '再看一下']);
    assert.equal(runner.seen.length, 2);
    assert.equal(runner.seen[1]!.threadId, runner.seen[0]!.threadId, '同一子会话');
    assert.equal(runner.seen[1]!.text, '再看一下');
    assert.ok(lines.join('\n').includes('续跑'));

    const hos = led.recentHandoffs(2);
    assert.equal(hos[0]!.taskId, first.taskId);
    assert.equal(hos[0]!.goal, '[续跑] 再看一下');
  });
});

test('/delegate --continue 拒绝非发起方', async () => {
  await withLedger(async (led) => {
    const { ctx, lines, runner } = makeCtx(led, new FakeRunner(), ['assistant']);
    await findCommand('/delegate')!.run(ctx, ['C', '修掉越界读']);
    const first = led.recentHandoffs(1)[0]!;

    // 换成 C 的身份（栈底放 fix 模块）
    ctx.state.stack = ['fix'];
    lines.length = 0;
    await findCommand('/delegate')!.run(ctx, ['--continue', first.taskId, '我接着改']);

    assert.equal(runner.seen.length, 1, '只有首跑那一次');
    assert.ok(lines.join('\n').includes('不能续'));
  });
});

test('/budget 与 /handoffs 不炸，且在空库时给人话', async () => {
  await withLedger(async (led) => {
    const { ctx, lines } = makeCtx(led, new FakeRunner());
    await findCommand('/budget')!.run(ctx, []);
    assert.ok(lines.join('\n').includes('有效令牌 0 张'));

    lines.length = 0;
    await findCommand('/handoffs')!.run(ctx, []);
    assert.ok(lines.join('\n').includes('还没有交接记录'));
  });
});

test('/budget 在签发后列出余额', async () => {
  await withLedger(async (led) => {
    const { ctx, lines } = makeCtx(led, new FakeRunner());
    await findCommand('/grant')!.run(ctx, ['B', '500']);
    lines.length = 0;
    await findCommand('/budget')!.run(ctx, []);
    const out = lines.join('\n');
    assert.ok(out.includes('有效令牌 1 张'));
    assert.ok(out.includes('余 500'));
  });
});
