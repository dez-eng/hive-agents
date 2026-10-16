/**
 * 循环护栏测试（v3 M2.5）。零 API —— 假模型 + 临时目录。
 *
 * 要证明：工具批次到顶就**结束本轮**（而不是回一句"到上限了"再让模型自由发挥 ——
 * 那会无限循环）；每批都有 ToolMessage 回应（历史不留 dangling 的 tool_calls）；
 * `HIVE_TOOL_STEPS` 可调、0 = 不限；关掉闸门时预算闸门能兜住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';

import { HiveAgent } from '../src/core/agent.js';
import { compressAt, compressKeep, toolSteps, turnBudget } from '../src/core/config.js';
import { getModule } from '../src/core/modules.js';

/** 永远要工具的假模型 —— 专门用来撞护栏（真模型不会这么干，所以必须用假的） */
class LoopChat extends BaseChatModel {
  calls = 0;

  constructor() {
    super({});
  }

  _llmType(): string {
    return 'loop';
  }

  override bindTools(): this {
    return this;
  }

  override async _generate(): Promise<any> {
    this.calls += 1;
    const msg = new AIMessage({
      content: '',
      usage_metadata: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      tool_calls: [{ name: 'calculator', args: { expression: '1+1' }, id: `c${this.calls}` }],
    });
    return { generations: [{ message: msg, text: '' }] };
  }
}

async function withLoop<T>(
  fn: (ctx: { agent: HiveAgent; chat: LoopChat }) => Promise<T>,
  env: Record<string, string> = {},
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'hive-guard-'));
  const chat = new LoopChat();
  const agent = new HiveAgent({ model: 'deepseek-flash', memoryPath: join(dir, 'm.db'), chat });

  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }

  try {
    return await fn({ agent, chat });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
}

test('护栏：到顶就结束本轮（默认 16 批），且历史不留 dangling tool_calls', async () => {
  await withLoop(async ({ agent, chat }) => {
    assert.equal(toolSteps(), 16, '默认值该是拍板的 16');

    const res = await agent.run({
      text: '一直算下去',
      threadId: 't1',
      module: getModule('assistant')!,
      tail: false,
      agent: 'A',
    });

    assert.equal(res.steps, 16, '执行了 16 批工具');
    assert.equal(chat.calls, 16, '模型调 16 次（每批工具前一次）；第 17 次不该发生，否则就是无限循环');
    assert.equal(res.budgetHit, false, '这次是步数栏杆停的，不是预算');

    const msgs = await agent.history('t1');
    assert.equal(
      msgs[msgs.length - 1]!.getType(),
      'tool',
      '最后一条必须是工具回包 —— 留下没人回应的 tool_calls 会被模型侧拒',
    );
  });
});

test('HIVE_TOOL_STEPS 可调：设成 2 就只跑 2 批', async () => {
  await withLoop(
    async ({ agent, chat }) => {
      const res = await agent.run({
        text: '一直算下去',
        threadId: 't2',
        module: getModule('assistant')!,
        tail: false,
        agent: 'A',
      });
      assert.equal(res.steps, 2);
      assert.equal(chat.calls, 2);
    },
    { HIVE_TOOL_STEPS: '2' },
  );
});

test('HIVE_TOOL_STEPS=0 表示不限：交给预算闸门兜住', async () => {
  await withLoop(
    async ({ agent }) => {
      const res = await agent.run({
        text: '一直算下去',
        threadId: 't3',
        module: getModule('assistant')!,
        tail: false,
        agent: 'A',
        budgetTokens: 1000,
      });
      assert.equal(res.budgetHit, true, '没步数上限时，闸门必须在某一轮拦下');
      assert.ok(res.steps > 2, `该跑了不少批才被拦：${res.steps}`);
    },
    { HIVE_TOOL_STEPS: '0' },
  );
});

test('两道护栏的默认值与 0 的语义', () => {
  const saved = {
    budget: process.env.HIVE_TURN_BUDGET,
    steps: process.env.HIVE_TOOL_STEPS,
    at: process.env.HIVE_COMPRESS_AT,
    keep: process.env.HIVE_COMPRESS_KEEP,
  };
  delete process.env.HIVE_TURN_BUDGET;
  delete process.env.HIVE_TOOL_STEPS;
  delete process.env.HIVE_COMPRESS_AT;
  delete process.env.HIVE_COMPRESS_KEEP;

  try {
    assert.equal(turnBudget(), 20000, '本轮闸门默认 20000');
    assert.equal(toolSteps(), 16, '步数默认 16');
    assert.equal(compressAt(), 24000, '压缩阈值默认 24000');
    assert.equal(compressKeep(), 16, '压缩后保留 16 条');

    process.env.HIVE_TURN_BUDGET = '0';
    process.env.HIVE_TOOL_STEPS = '0';
    assert.equal(turnBudget(), 0, '0 = 不封顶');
    assert.equal(toolSteps(), 0, '0 = 不限');

    process.env.HIVE_TURN_BUDGET = '乱写';
    assert.equal(turnBudget(), 20000, '写坏了退回默认，不是变成 0');
  } finally {
    const restore = (k: string, v: string | undefined): void => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('HIVE_TURN_BUDGET', saved.budget);
    restore('HIVE_TOOL_STEPS', saved.steps);
    restore('HIVE_COMPRESS_AT', saved.at);
    restore('HIVE_COMPRESS_KEEP', saved.keep);
  }
});
