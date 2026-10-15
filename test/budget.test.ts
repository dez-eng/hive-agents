/**
 * 预算闸门 + 假模型测试。全部零 API。
 *
 * 假模型自产 usage_metadata —— 没有它，meter 永远是 0，闸门根本不会触发，
 * 那样测出来的「通过」是假的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';

import { BudgetExceeded, exceedsBudget, isBudgetExceeded, tokenSpent } from '../src/core/budget.js';
import { HiveAgent } from '../src/core/agent.js';
import { getModule } from '../src/core/modules.js';

interface FakeTurn {
  content: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id: string }>;
}

/** 每轮都自带计量的假模型 —— 测试里唯一的「模型」 */
class FakeChat extends BaseChatModel {
  calls = 0;

  constructor(
    private readonly turns: FakeTurn[],
    private readonly inTok: number,
    private readonly outTok: number,
  ) {
    super({});
  }

  _llmType(): string {
    return 'fake';
  }

  // 注入的模型必须能 bindTools，否则 buildGraph 挂不上工具
  override bindTools(): this {
    return this;
  }

  override async _generate(): Promise<any> {
    const t = this.turns[Math.min(this.calls, this.turns.length - 1)]!;
    this.calls += 1;
    const msg = new AIMessage({
      content: t.content,
      usage_metadata: {
        input_tokens: this.inTok,
        output_tokens: this.outTok,
        total_tokens: this.inTok + this.outTok,
      },
      ...(t.toolCalls ? { tool_calls: t.toolCalls } : {}),
    });
    return { generations: [{ message: msg, text: t.content }] };
  }
}

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'hive-budget-'));
  return fn(dir).finally(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上 SqliteSaver 还占着 memory.db 的句柄 —— 删不掉就留给系统清 */
    }
  });
}

test('tokenSpent = 入 + 出；负数按 0 算', () => {
  assert.equal(tokenSpent({ inTok: 100, outTok: 20 }), 120);
  assert.equal(tokenSpent({ inTok: -5, outTok: 10 }), 10);
  assert.equal(tokenSpent({ inTok: 0, outTok: 0 }), 0);
});

test('exceedsBudget：0 / 负数即无闸门，刚好用满不算超', () => {
  assert.equal(exceedsBudget({ inTok: 999, outTok: 999 }, 0), false, '0 = 不封顶');
  assert.equal(exceedsBudget({ inTok: 999, outTok: 999 }, -1), false);
  assert.equal(exceedsBudget({ inTok: 10, outTok: 5 }, 15), false, '刚好用满要放行');
  assert.equal(exceedsBudget({ inTok: 10, outTok: 6 }, 15), true);
});

test('BudgetExceeded 带 spent/budget，且 isBudgetExceeded 能顺 cause 链认出', () => {
  const e = new BudgetExceeded(200, 100);
  assert.equal(e.name, 'BudgetExceeded');
  assert.equal(e.spent, 200);
  assert.equal(e.budget, 100);
  assert.ok(e instanceof Error);
  assert.ok(isBudgetExceeded(e));
  assert.ok(isBudgetExceeded(new Error('框架包了一层', { cause: e })), '被包裹也要认出来');
  assert.equal(isBudgetExceeded(new Error('无关错误')), false);
  assert.equal(isBudgetExceeded(undefined), false);
});

test('假模型跑通一轮工具轮：无闸门时不熔断，两次调用都记上', async () => {
  await withTempDir(async (dir) => {
    const chat = new FakeChat(
      [
        { content: '', toolCalls: [{ name: 'calculator', args: { expression: '1+1' }, id: 'call_1' }] },
        { content: '结果是 2' },
      ],
      100,
      20,
    );
    const agent = new HiveAgent({ model: 'deepseek-flash', memoryPath: join(dir, 'm.db'), chat });
    const mod = getModule('assistant')!; // assistant 开了 calculator

    const res = await agent.run({ text: '1+1 等于几', threadId: 't1', module: mod, tail: false });

    assert.equal(res.budgetHit, false);
    assert.equal(res.text, '结果是 2');
    assert.equal(res.meter.calls, 2, '工具轮 = 两次模型调用');
    assert.equal(res.meter.inTok, 200, '两次入各 100');
    assert.equal(res.meter.outTok, 40);
    assert.equal(chat.calls, 2);
  });
});

test('预算闸门：第二次 callModel 前熔断，模型只被调一次', async () => {
  await withTempDir(async (dir) => {
    // 每轮消耗 1100 token；预算 500 —— 第一轮后必然超
    const chat = new FakeChat(
      [
        { content: '', toolCalls: [{ name: 'calculator', args: { expression: '1+1' }, id: 'call_1' }] },
        { content: '不该走到这里' },
      ],
      1000,
      100,
    );
    const agent = new HiveAgent({ model: 'deepseek-flash', memoryPath: join(dir, 'm.db'), chat });
    const mod = getModule('assistant')!;

    const res = await agent.run({
      text: '1+1 等于几',
      threadId: 't2',
      module: mod,
      tail: false,
      budgetTokens: 500,
    });

    assert.equal(res.budgetHit, true, '被闸门熔断');
    assert.equal(chat.calls, 1, '模型只被调了一次 —— 第二次在发请求前就拦下了');
    assert.equal(res.meter.calls, 1);
  });
});

test('预算充足时不影响工具轮正常收尾', async () => {
  await withTempDir(async (dir) => {
    const chat = new FakeChat(
      [
        { content: '', toolCalls: [{ name: 'calculator', args: { expression: '2*3' }, id: 'c1' }] },
        { content: '6' },
      ],
      100,
      20,
    );
    const agent = new HiveAgent({ model: 'deepseek-flash', memoryPath: join(dir, 'm.db'), chat });
    const mod = getModule('assistant')!;

    const res = await agent.run({
      text: '2*3',
      threadId: 't3',
      module: mod,
      tail: false,
      budgetTokens: 100_000,
    });

    assert.equal(res.budgetHit, false);
    assert.equal(res.text, '6');
    assert.equal(chat.calls, 2);
  });
});
