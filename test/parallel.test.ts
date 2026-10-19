/**
 * v4 M4.1 并行借调的零 API 测试。
 *
 * 要证明四件事：
 *   1. 两个子任务**真的同时在跑**（不是排队），且各自 thread / taskId 独立
 *   2. runtime 隔离 —— 并发下计量与拒绝计数不串（ALS 改造的验收）
 *   3. 同一张令牌并发借调：预留是原子的，不会超卖
 *   4. 并行里一个被策略拒/预算不够，不影响同批其它任务
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';

import { HiveAgent, type DelegateContext } from '../src/core/agent.js';
import type { TurnRequest, TurnResult } from '../src/core/agent.js';
import { TokenMeter } from '../src/core/meter.js';
import { Ledger } from '../src/core/ledger.js';
import { AGENTS, getModule } from '../src/core/modules.js';
import { issueToken, type Token } from '../src/core/grant.js';
import { TASKS } from '../src/core/tasks.js';
import type { TurnRunner } from '../src/core/subagent.js';

interface FakeTurn {
  content: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id: string }>;
}

class FakeChat extends BaseChatModel {
  calls = 0;
  readonly seen: BaseMessage[][] = [];
  constructor(private turns: FakeTurn[]) {
    super({});
  }
  _llmType(): string {
    return 'fake';
  }
  override bindTools(): this {
    return this;
  }
  override async _generate(messages: BaseMessage[]): Promise<any> {
    this.seen.push(messages);
    const t = this.turns[Math.min(this.calls, this.turns.length - 1)]!;
    this.calls += 1;
    const msg = new AIMessage({
      content: t.content,
      usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      ...(t.toolCalls ? { tool_calls: t.toolCalls } : {}),
    });
    return { generations: [{ message: msg, text: t.content }] };
  }
}

/**
 * 并发探针：两个 run 都进门后一起放行；peak 说明是否真并行。
 * 只应到一个时靠超时放行，免得测试挂死。
 */
class BarrierRunner implements TurnRunner {
  readonly seen: TurnRequest[] = [];
  active = 0;
  peak = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((r) => {
    this.release = r;
  });
  constructor(
    private readonly expect: number,
    private readonly waitMs = 1000,
  ) {}

  async run(req: TurnRequest): Promise<TurnResult> {
    this.seen.push(req);
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    if (this.active >= this.expect) this.release();
    await Promise.race([this.gate, new Promise((r) => setTimeout(r, this.waitMs))]);
    this.active -= 1;

    const meter = new TokenMeter({ model: 'deepseek-flash' });
    meter.absorb({ calls: 1, inTok: 100, outTok: 20, cacheHit: 0, reasoning: 0 });
    return {
      text: `done:${req.agent}`,
      sentContent: req.text,
      meter,
      budgetHit: false,
      denied: 0,
      steps: 0,
    };
  }
}

function ctxFor(o: {
  led: Ledger;
  runner: TurnRunner;
  from: DelegateContext['from'];
  token: Token | null;
}): DelegateContext {
  let n = 0;
  const ctx: DelegateContext = {
    ledger: o.led,
    thread: 'main',
    from: o.from,
    token: o.token,
    runner: o.runner,
    moduleOf: (as) => getModule(AGENTS[as].home)!,
    tail: true,
    seq: () => {
      n += 1;
      return n;
    },
    makeChild: () => ctx,
  };
  return ctx;
}

async function withRig<T>(
  fn: (rig: { dir: string; led: Ledger; agent: HiveAgent; chat: FakeChat; runner: BarrierRunner }) => Promise<T>,
  opts: { turns: FakeTurn[]; expect: number; waitMs?: number },
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'hive-par-'));
  const led = new Ledger(join(dir, 't.db'));
  led.open();
  TASKS.clear();
  try {
    const chat = new FakeChat(opts.turns);
    const runner = new BarrierRunner(opts.expect, opts.waitMs);
    const agent = new HiveAgent({ model: 'deepseek-flash', memoryPath: join(dir, 'm.db'), chat });
    return await fn({ dir, led, agent, chat, runner });
  } finally {
    led.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
}

const PAR_A = {
  name: 'delegate',
  args: {
    parallel: [
      { to: 'C', goal: '改 a', slice: 'a.ts:1', expect: 'diff', budgetTokens: 200 },
      { to: 'D', goal: '审 b', slice: 'b.ts:1', expect: '结论', budgetTokens: 200 },
    ],
  },
  id: 'd1',
};

test('A 并行派 C 和 D：真并发、thread/task 各自独立、结果带 taskId', async () => {
  await withRig(
    async ({ led, agent, runner, chat }) => {
      const delegate = ctxFor({ led, runner, from: 'A', token: null });
      const res = await agent.run({
        text: '两件事一起办',
        threadId: 'main',
        module: getModule('assistant')!,
        tail: false,
        delegate,
        agent: 'A',
        ledger: led,
      });

      assert.equal(res.text, '都办完了');
      assert.equal(runner.peak, 2, '两个子任务同时在跑');
      assert.equal(runner.seen.length, 2);

      const threads = runner.seen.map((r) => r.threadId).sort();
      assert.equal(new Set(threads).size, 2, '子 thread 不重复');
      assert.ok(threads.some((t) => t.startsWith('main#C#t001-')), threads.join(','));
      assert.ok(threads.some((t) => t.startsWith('main#D#t002-')), threads.join(','));

      const hos = led.recentHandoffs(2);
      assert.equal(hos.length, 2);
      assert.deepEqual(hos.map((h) => h.to).sort(), ['C', 'D']);
      assert.equal(new Set(hos.map((h) => h.taskId)).size, 2, '两个 taskId 不重复');

      // 模型第二轮拿到的工具回包里必须有 taskId，否则「接着问」无从谈起
      const toolMsg = chat.seen[1]!;
      assert.ok(toolMsg, '父模型该被再调一次');
      const last = toolMsg[toolMsg.length - 1]!;
      const body = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      assert.match(body, /并行借调 2 个 · 完成 2/);
      assert.match(body, /C·t001-/);
      assert.match(body, /D·t002-/);

      // /tasks 的数据源：两个都登记为完成
      const tasks = TASKS.list();
      assert.equal(tasks.length, 2);
      assert.ok(tasks.every((t) => t.state === 'done'));
    },
    { turns: [{ content: '', toolCalls: [PAR_A] }, { content: '都办完了' }], expect: 2 },
  );
});

test('B 用同一张令牌并行借调：预留在 SQL 里原子完成，最终按实际消耗扣 240', async () => {
  await withRig(
    async ({ led, agent, runner }) => {
      const r = issueToken('B', { budgetTokens: 500 });
      assert.ok(r.ok);
      const token = (r as { ok: true; token: Token }).token;
      led.saveToken(token);

      const delegate = ctxFor({ led, runner, from: 'B', token });
      const res = await agent.run({
        text: '两个人一起查',
        threadId: 'main',
        module: getModule('recon')!,
        tail: false,
        delegate,
        agent: 'B',
        ledger: led,
      });

      assert.equal(res.text, '都办完了');
      assert.equal(runner.peak, 2);
      assert.equal(led.loadToken(token.id)!.spent, 240, '两个子任务各 120');
    },
    { turns: [{ content: '', toolCalls: [PAR_A] }, { content: '都办完了' }], expect: 2 },
  );
});

test('预算不够时并发预留挡住第二个：不超卖，且不影响第一个跑完', async () => {
  await withRig(
    async ({ led, agent, runner, chat }) => {
      const r = issueToken('B', { budgetTokens: 500 });
      assert.ok(r.ok);
      const token = (r as { ok: true; token: Token }).token;
      led.saveToken(token);

      const delegate = ctxFor({ led, runner, from: 'B', token });
      const res = await agent.run({
        text: '各要 300，但令牌只有 500',
        threadId: 'main',
        module: getModule('recon')!,
        tail: false,
        delegate,
        agent: 'B',
        ledger: led,
      });

      assert.equal(res.text, '都办完了');
      assert.equal(runner.seen.length, 1, '只放行一个；另一个在预留下失败，不进模型');
      assert.equal(led.loadToken(token.id)!.spent, 120, '失败的那笔不扣钱');
      assert.equal(led.recentHandoffs(2).length, 1, '没发生的子任务不留 trace');

      const body = chat.seen[1]!.at(-1)!.content;
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      assert.match(text, /完成 1/);
      assert.match(text, /并发预留失败/);
    },
    {
      turns: [
        {
          content: '',
          toolCalls: [
            {
              name: 'delegate',
              args: {
                parallel: [
                  { to: 'C', goal: '改 a', slice: 'a.ts:1', expect: 'diff', budgetTokens: 300 },
                  { to: 'D', goal: '审 b', slice: 'b.ts:1', expect: '结论', budgetTokens: 300 },
                ],
              },
              id: 'd1',
            },
          ],
        },
        { content: '都办完了' },
      ],
      expect: 2,
      waitMs: 50,
    },
  );
});

test('并行里一项被策略拒：只拒那一项，另一项照跑，拒绝计数进本轮', async () => {
  await withRig(
    async ({ led, agent, runner }) => {
      const r = issueToken('B', { budgetTokens: 500 });
      assert.ok(r.ok);
      const token = (r as { ok: true; token: Token }).token;
      led.saveToken(token);

      // B 的 mayCall 只有 C/D —— A 应被逐项挡下，C 照跑
      const delegate = ctxFor({ led, runner, from: 'B', token });
      const res = await agent.run({
        text: '一个不该派，一个该派',
        threadId: 'main',
        module: getModule('recon')!,
        tail: false,
        delegate,
        agent: 'B',
        ledger: led,
      });

      assert.equal(res.text, '都办完了');
      assert.equal(runner.seen.length, 1, '被拒的那项不该进模型');
      assert.equal(runner.seen[0]!.agent, 'C');
      assert.equal(res.denied, 1, '逐项判定要计入本轮的「拒 N」');
      assert.equal(led.recentHandoffs(2).length, 1);
      assert.equal(TASKS.list().length, 1, '被策略拒的那项没进执行核，不占任务位');
    },
    { turns: [{ content: '', toolCalls: [{ name: 'delegate', args: ({ parallel: [
      { to: 'A', goal: '让主控干', slice: 'x', expect: 'y', budgetTokens: 100 },
      { to: 'C', goal: '改 a', slice: 'a.ts:1', expect: 'diff', budgetTokens: 200 },
    ] }), id: 'd1' }] }, { content: '都办完了' }], expect: 2, waitMs: 50 },
  );
});
