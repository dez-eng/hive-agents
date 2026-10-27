/**
 * v3 M3.5（B 主动反问 A）的零 API 测试。
 *
 * 要证明四件事：
 *   1. 装配：B/C/D 有 ask_parent，A 没有；它无副作用、不进网关
 *   2. 暂停：子任务调 ask_parent → 本轮结束、模型不再被调用，问题进 TurnResult
 *   3. 没有父：独立会话调 ask_parent 只得到一句 ERROR，本轮继续
 *   4. 交接：question 透传到 HandoffResult，父侧话术给出 taskId + resume 形状
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';

import { HiveAgent, formatDelegateResult, type TurnRequest, type TurnResult } from '../src/core/agent.js';
import { Ledger } from '../src/core/ledger.js';
import { TokenMeter } from '../src/core/meter.js';
import { AGENTS, getModule } from '../src/core/modules.js';
import { capabilityOfTool, kindOf, toolNamesFor } from '../src/core/capability.js';
import { ASK_MAX_CHARS, ASK_TOOL, askParentTool, clipQuestion } from '../src/core/dialog.js';
import { parseHandoffInput } from '../src/core/handoff.js';
import { continueSubagent, runSubagent, type TurnRunner } from '../src/core/subagent.js';
import { issueToken, type Token } from '../src/core/grant.js';

interface FakeTurn {
  content: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id: string }>;
}

class FakeChat extends BaseChatModel {
  calls = 0;
  readonly seen: BaseMessage[][] = [];
  constructor(private readonly turns: FakeTurn[]) {
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

/** 子轮一跑就反问的 runner —— 用来测 handoff 透传 */
class AskRunner implements TurnRunner {
  readonly seen: TurnRequest[] = [];
  constructor(private readonly question: string) {}
  async run(req: TurnRequest): Promise<TurnResult> {
    this.seen.push(req);
    const meter = new TokenMeter({ model: 'deepseek-flash' });
    meter.absorb({ calls: 1, inTok: 100, outTok: 20, cacheHit: 0, reasoning: 0 });
    return {
      text: '我需要更多信息。',
      sentContent: req.text,
      meter,
      budgetHit: false,
      denied: 0,
      steps: 1,
      question: this.question,
    };
  }
}

/** 普通跑完的 runner —— 用来测续跑 */
class PlainRunner implements TurnRunner {
  readonly seen: TurnRequest[] = [];
  async run(req: TurnRequest): Promise<TurnResult> {
    this.seen.push(req);
    const meter = new TokenMeter({ model: 'deepseek-flash' });
    meter.absorb({ calls: 1, inTok: 100, outTok: 20, cacheHit: 0, reasoning: 0 });
    return {
      text: '按你的回答做完了',
      sentContent: req.text,
      meter,
      budgetHit: false,
      denied: 0,
      steps: 0,
    };
  }
}

function withTmp<T>(fn: (dir: string, led: Ledger) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'hive-ask-'));
  const led = new Ledger(join(dir, 't.db'));
  led.open();
  return fn(dir, led).finally(() => {
    led.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  });
}

function tokenFor(to: 'B' | 'C' | 'D', budget = 500): Token {
  const r = issueToken(to, { budgetTokens: budget });
  assert.ok(r.ok);
  return (r as { ok: true; token: Token }).token;
}

test('装配：B/C/D 有 ask_parent，A 没有；无副作用、不进网关', () => {
  for (const a of ['B', 'C', 'D'] as const) {
    assert.ok(toolNamesFor(a).includes(ASK_TOOL), `${a} 应该装 ask_parent`);
  }
  assert.ok(!toolNamesFor('A').includes(ASK_TOOL), 'A 是发起方，没有父');
  assert.equal(capabilityOfTool(ASK_TOOL), 'ask');
  assert.equal(kindOf(ASK_TOOL), undefined, 'ask_parent 不读写、不联网，不该进网关');
});

test('问题截断：空白归空，超长截到上限', () => {
  assert.equal(clipQuestion('  '), '');
  const long = 'a'.repeat(ASK_MAX_CHARS + 10);
  const cut = clipQuestion(long);
  assert.equal(cut.length, ASK_MAX_CHARS + 1, '保留上限 + 一个省略号');
  assert.ok(cut.endsWith('…'));
});

test('工具直接 invoke 不干活 —— 真正执行在执行层', async () => {
  const r = String(await askParentTool.invoke({ question: '在吗' } as never));
  assert.ok(r.startsWith('ERROR'), r);
});

test('子任务：调 ask_parent → 本轮暂停，模型只被调用一次', async () => {
  await withTmp(async (dir, led) => {
    const chat = new FakeChat([
      {
        content: '我需要确认一下。',
        toolCalls: [{ name: ASK_TOOL, args: { question: '要改哪个分支？' }, id: 'a1' }],
      },
      { content: '不该被调用' },
    ]);
    const agent = new HiveAgent({ model: 'deepseek-flash', memoryPath: join(dir, 'm.db'), chat });

    const res = await agent.run({
      text: '修一下这个 bug',
      threadId: 'main#B#t001-x',
      module: getModule('recon')!,
      tail: false,
      agent: 'B',
      ledger: led,
      taskId: 't001-x',
      parent: { from: 'A', taskId: 't001-x' },
    });

    assert.equal(res.question, '要改哪个分支？');
    assert.equal(res.text, '我需要确认一下。');
    assert.equal(chat.calls, 1, '暂停后不再调模型（否则它会自问自答）');

    const hist = await agent.history('main#B#t001-x');
    assert.equal(hist.at(-1)!.getType(), 'tool', '最后一条是 ToolMessage，下次续跑消息序列合法');
    assert.match(String(hist.at(-1)!.content), /已暂停/);
  });
});

test('没有父：独立会话调 ask_parent 只得到 ERROR，本轮继续', async () => {
  await withTmp(async (dir, led) => {
    const chat = new FakeChat([
      {
        content: '',
        toolCalls: [{ name: ASK_TOOL, args: { question: '在吗' }, id: 'a1' }],
      },
      { content: '那我先按默认做' },
    ]);
    const agent = new HiveAgent({ model: 'deepseek-flash', memoryPath: join(dir, 'm.db'), chat });

    // B 有 ask 能力，但独立会话没有 parent
    const res = await agent.run({
      text: '自己看着办',
      threadId: 'solo#B',
      module: getModule('recon')!,
      tail: false,
      agent: 'B',
      ledger: led,
    });

    assert.equal(res.question, undefined);
    assert.equal(chat.calls, 2, '没有父 = 普通工具轮，模型继续');
    const hist = await agent.history('solo#B');
    const tools = hist.filter((m) => m.getType() === 'tool');
    assert.match(String(tools.at(-1)!.content), /没有父会话/);
  });
});

test('交接：子轮问题透传到 HandoffResult，notes 标记暂停', async () => {
  await withTmp(async (dir, led) => {
    const parsed = parseHandoffInput({
      taskId: 't001-x',
      from: 'A',
      to: 'B',
      goal: '查一下这个配置',
      slice: 'config.ts:1 xx',
      expect: '结论',
      budgetTokens: 100,
    });
    assert.ok(parsed.ok);

    const runner = new AskRunner('这份配置属于哪个环境？');
    const res = await runSubagent({
      as: 'B',
      from: 'A',
      input: parsed.value,
      token: null, // A 免令牌
      thread: 'main',
      deps: {
        runner,
        ledger: led,
        module: getModule(AGENTS.B.home)!,
        tail: false,
      },
    });

    assert.equal(res.question, '这份配置属于哪个环境？');
    assert.equal(res.notes, '暂停等上级回答');
    assert.equal(res.ok, true);
    assert.equal(runner.seen[0]!.parent?.from, 'A', '子轮知道自己有父');
    assert.equal(runner.seen[0]!.parent?.taskId, 't001-x');

    const ho = led.recentHandoffs(1)[0]!;
    assert.equal(ho.ok, true);
    assert.ok(ho.notes?.includes('暂停'), 'handoffs 里能看出这是暂停而不是完成');
  });
});

test('父侧话术：给出问题、taskId 与 resume 形状', () => {
  const text = formatDelegateResult(
    {
      taskId: 't001-x',
      ok: true,
      tokens: 50,
      costUsd: 0,
      budgetHit: false,
      question: '缺目标文件',
    },
    'B',
    100,
  );
  assert.match(text, /暂停/);
  assert.match(text, /缺目标文件/);
  assert.match(text, /resume="t001-x"/);
  assert.match(text, /budgetTokens/);
});

test('续跑：带 question 的交接仍可回答，同一子 thread', async () => {
  await withTmp(async (dir, led) => {
    const parsed = parseHandoffInput({
      taskId: 't001-x',
      from: 'A',
      to: 'B',
      goal: '查一下',
      slice: 'x',
      expect: '结论',
      budgetTokens: 100,
    });
    assert.ok(parsed.ok);

    const ask = new AskRunner('缺哪个文件？');
    const first = await runSubagent({
      as: 'B',
      from: 'A',
      input: parsed.value,
      token: null,
      thread: 'main',
      deps: { runner: ask, ledger: led, module: getModule(AGENTS.B.home)!, tail: false },
    });
    assert.equal(first.question, '缺哪个文件？');
    assert.ok(first.thread);

    const plain = new PlainRunner();
    const second = await continueSubagent({
      as: 'B',
      from: 'A',
      owner: 'A',
      token: null,
      thread: first.thread!,
      taskId: 't001-x',
      text: '缺 config.ts，去 read_file',
      budgetTokens: 100,
      deps: { runner: plain, ledger: led, module: getModule(AGENTS.B.home)!, tail: false },
    });

    assert.equal(second.ok, true);
    assert.equal(second.question, undefined);
    assert.equal(plain.seen[0]!.threadId, first.thread, '续跑复用同一个 thread');
    assert.equal(plain.seen[0]!.parent?.taskId, 't001-x', '续跑时仍知道父是谁');
  });
});
