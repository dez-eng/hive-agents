/**
 * 工具层 + delegate 执行层测试。零 API。
 *
 * 要证明：工具一次加齐（§7）、执行层白名单收权、delegate 被 callTools 特判接管后
 * 真的走 runSubagent（授权 + 预算 + 子 thread + 留痕）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';

import { HiveAgent, type DelegateContext } from '../src/core/agent.js';
import type { TurnRequest, TurnResult } from '../src/core/agent.js';
import { TokenMeter } from '../src/core/meter.js';
import { Ledger } from '../src/core/ledger.js';
import { AGENTS, getModule } from '../src/core/modules.js';
import { ALL_TOOLS, TOOL_MAP, toolNamesFor } from '../src/core/capability.js';
import { issueToken, type Token } from '../src/core/grant.js';
import type { TurnRunner } from '../src/core/subagent.js';

interface FakeTurn {
  content: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id: string }>;
}

class FakeChat extends BaseChatModel {
  calls = 0;
  constructor(
    private readonly turns: FakeTurn[],
    private readonly inTok = 100,
    private readonly outTok = 20,
  ) {
    super({});
  }
  _llmType(): string {
    return 'fake';
  }
  override bindTools(): this {
    return this;
  }
  override async _generate(): Promise<any> {
    const t = this.turns[Math.min(this.calls, this.turns.length - 1)]!;
    this.calls += 1;
    const msg = new AIMessage({
      content: t.content,
      usage_metadata: { input_tokens: this.inTok, output_tokens: this.outTok, total_tokens: this.inTok + this.outTok },
      ...(t.toolCalls ? { tool_calls: t.toolCalls } : {}),
    });
    return { generations: [{ message: msg, text: t.content }] };
  }
}

class FakeRunner implements TurnRunner {
  readonly seen: TurnRequest[] = [];
  async run(req: TurnRequest): Promise<TurnResult> {
    this.seen.push(req);
    const meter = new TokenMeter({ model: 'deepseek-flash' });
    meter.absorb({ calls: 1, inTok: 100, outTok: 20, cacheHit: 0, reasoning: 0 });
    return { text: '改动完成：把比较改成 startsWith', sentContent: req.text, meter, budgetHit: false, denied: 0 };
  }
}

function mkToken(to: 'B' | 'C' | 'D', budget = 500): Token {
  const r = issueToken(to, { budgetTokens: budget });
  assert.ok(r.ok);
  return (r as { ok: true; token: Token }).token;
}

const DEL = { name: 'delegate', args: { to: 'C', goal: '修越界读', slice: 'a.ts:1 xx', expect: 'diff', budgetTokens: 200 }, id: 'd1' };

test('工具注册表齐备：write_file 与 delegate 都在 ALL_TOOLS（v3：归 capability）', () => {
  const names = ALL_TOOLS.map((t) => t.name);
  assert.ok(names.includes('write_file'), 'write_file 该进 ALL_TOOLS');
  assert.ok(names.includes('delegate'), 'delegate 该进 ALL_TOOLS');
});

test('v3 M2：工具按**身份**装配（模块表不再管这个）', () => {
  assert.ok(toolNamesFor('A').includes('delegate'));
  assert.ok(toolNamesFor('B').includes('delegate'));
  assert.ok(toolNamesFor('C').includes('write_file'));
  assert.ok(!toolNamesFor('C').includes('delegate'), 'C 不借调谁');
  assert.ok(!toolNamesFor('D').includes('delegate'), 'D 不借调谁');
  assert.ok(!toolNamesFor('A').includes('bash'), 'M2 没有 shell capability 的工具');
});

test('delegate 工具直接 invoke 不干活 —— 真正执行在执行层', async () => {
  const r = String(await TOOL_MAP['delegate']!.invoke(DEL.args));
  assert.ok(r.startsWith('ERROR'), r);
});

test('write_file：能写项目内文件、挡越界', async () => {
  const rf = TOOL_MAP['write_file']!;
  const escape = String(await rf.invoke({ path: '../../etc/passwd', content: 'x' }));
  assert.ok(escape.startsWith('ERROR'), '越界要挡');
  assert.ok(escape.includes('越界'));

  const rel = `.tmp-write-test-${process.pid}.txt`;
  const abs = resolve(process.cwd(), rel);
  try {
    const ok = String(await rf.invoke({ path: rel, content: 'hello hive' }));
    assert.ok(ok.startsWith('OK'), ok);
    assert.equal(readFileSync(abs, 'utf8'), 'hello hive');
  } finally {
    try {
      rmSync(abs, { force: true });
    } catch {
      /* 清理失败不影响断言 */
    }
  }
});

test('delegate 执行层：模型调 delegate → runSubagent 跑子任务 + 留痕', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-del-'));
  const led = new Ledger(join(dir, 't.db'));
  led.open();
  try {
    const chat = new FakeChat([{ content: '', toolCalls: [DEL] }, { content: '已交给修复' }]);
    const runner = new FakeRunner();
    const token = mkToken('B', 500);
    led.saveToken(token);
    const agent = new HiveAgent({ model: 'deepseek-flash', memoryPath: join(dir, 'm.db'), chat });

    const delegate: DelegateContext = {
      ledger: led,
      thread: 'main',
      from: 'B',
      token,
      runner,
      moduleOf: (as) => getModule(AGENTS[as].home)!,
      tail: true,
      seq: () => 1,
    };

    const res = await agent.run({
      text: '看看这个越界读',
      threadId: 'main',
      module: getModule('recon')!, // B：开了 delegate
      tail: false,
      delegate,
      agent: 'B', // v3 M2：这一轮是谁在跑（决定工具集与网关判据）
    });

    assert.equal(res.text, '已交给修复');
    assert.equal(runner.seen.length, 1, '子任务真的跑了');
    assert.equal(runner.seen[0]!.module.id, 'fix', '交给的是 C 的主模块');
    assert.ok(runner.seen[0]!.threadId.startsWith('main#C#t001-'), '子 thread 物理隔离');

    const ho = led.recentHandoffs(1)[0]!;
    assert.equal(ho.from, 'B');
    assert.equal(ho.to, 'C');
    assert.equal(ho.ok, true);
    assert.equal(led.loadToken(token.id)!.spent, 120);
  } finally {
    led.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
});

test('v3 M2：身份没装的能力，调它 → 被门挡住，子任务不跑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-del2-'));
  const led = new Ledger(join(dir, 't.db'));
  led.open();
  try {
    const chat = new FakeChat([{ content: '', toolCalls: [DEL] }, { content: '被挡了' }]);
    const runner = new FakeRunner();
    const agent = new HiveAgent({ model: 'deepseek-flash', memoryPath: join(dir, 'm.db'), chat });

    const delegate: DelegateContext = {
      ledger: led,
      thread: 'main',
      // v3 M2：判据是**身份**不是模块 —— D 的 capabilities 里没有 delegate
      from: 'D',
      token: null,
      runner,
      moduleOf: (as) => getModule(AGENTS[as].home)!,
      tail: true,
      seq: () => 1,
    };

    await agent.run({
      text: '算一下',
      threadId: 'main',
      module: getModule('audit')!, // D 的主模块（模块不再管工具了）
      tail: false,
      delegate,
      agent: 'D',
    });

    assert.equal(runner.seen.length, 0, 'D 没装 delegate 能力，子任务不该跑');
    assert.equal(led.recentHandoffs(1).length, 0);
  } finally {
    led.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
});
