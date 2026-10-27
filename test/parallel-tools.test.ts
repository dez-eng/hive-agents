/**
 * v4 性能：批内并行的零 API 测试（docs/V4-PERF-DESIGN.md）。
 *
 * 要证明三件事：
 *   1. 判据：只读工具并发、副作用/顺序敏感工具串行、MCP 写操作按名字拦截
 *   2. 事实：同批两个只读调用真的同时在跑（maxActive === 2）
 *   3. 边界：同批两个写调用保持串行（maxActive === 1），结果顺序与调用一致
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage } from '@langchain/core/messages';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';

import { HiveAgent, canRunToolInParallel } from '../src/core/agent.js';
import { enableMcpFor, registerMcpTools } from '../src/core/capability.js';
import { Ledger } from '../src/core/ledger.js';
import { AGENTS, getModule } from '../src/core/modules.js';
import { DEFAULT_SPEC, setPolicySpec } from '../src/core/policy.js';

interface FakeTurn {
  content: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id: string }>;
}

class FakeChat extends BaseChatModel {
  calls = 0;
  constructor(private readonly turns: FakeTurn[]) {
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
      usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      ...(t.toolCalls ? { tool_calls: t.toolCalls } : {}),
    });
    return { generations: [{ message: msg, text: t.content }] };
  }
}

let active = 0;
let maxActive = 0;
const order: string[] = [];

function resetCounters(): void {
  active = 0;
  maxActive = 0;
  order.length = 0;
}

function slowTool(name: string, ms = 50): StructuredToolInterface {
  return tool(
    async (): Promise<string> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(name);
      await new Promise((r) => setTimeout(r, ms));
      active -= 1;
      return `done:${name}`;
    },
    { name, description: '测试用慢工具', schema: z.object({}) },
  ) as StructuredToolInterface;
}

const origCaps = [...AGENTS.A.capabilities];

function restore(): void {
  AGENTS.A.capabilities = [...origCaps];
  registerMcpTools([]);
  setPolicySpec(null);
}

test.after(restore);

test('判据：只读并发，副作用与顺序敏感工具串行', () => {
  for (const name of ['read_file', 'grep', 'glob', 'calculator', 'web_fetch']) {
    assert.equal(canRunToolInParallel(name), true, name);
  }
  for (const name of ['write_file', 'edit_file', 'bash', 'load_skill', 'ask_parent']) {
    assert.equal(canRunToolInParallel(name), false, name);
  }
  assert.equal(canRunToolInParallel('delegate', { to: 'B' }), true, '单个借调可以并发');
  assert.equal(
    canRunToolInParallel('delegate', { parallel: [{ to: 'B' }, { to: 'C' }] }),
    false,
    'parallel 内部已并发，不再套一层',
  );
  assert.equal(canRunToolInParallel('mcp__filesystem__read_file'), true);
  assert.equal(canRunToolInParallel('mcp__filesystem__write_file'), false, 'MCP 写操作按名字拦');
  assert.equal(canRunToolInParallel('mcp__memory__create_entities'), false);
  assert.equal(canRunToolInParallel('mcp__memory__read_graph'), true);
  assert.equal(canRunToolInParallel('unknown_tool'), false, '不认识就保守串行');
});

async function runBatch(tools: StructuredToolInterface[], calls: FakeTurn['toolCalls']): Promise<{
  max: number;
  order: string[];
  tools: string[];
}> {
  resetCounters();
  const dir = mkdtempSync(join(tmpdir(), 'hive-par-'));
  const led = new Ledger(join(dir, 't.db'));
  led.open();
  try {
    registerMcpTools(tools);
    enableMcpFor(['A']);
    setPolicySpec({ ...DEFAULT_SPEC, mcp: { allowServers: ['test'] } });

    const chat = new FakeChat([{ content: '', toolCalls: calls }, { content: '完成' }]);
    const agent = new HiveAgent({ model: 'deepseek-flash', memoryPath: join(dir, 'm.db'), chat });
    await agent.run({
      text: '跑两个工具',
      threadId: 'main',
      module: getModule('assistant')!,
      tail: false,
      agent: 'A',
      ledger: led,
    });

    const hist = await agent.history('main');
    const toolMsgs = hist.filter((m) => m.getType() === 'tool').map((m) => String(m.content));
    return { max: maxActive, order: [...order], tools: toolMsgs };
  } finally {
    led.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
}

test('并发事实：同批两个只读 MCP 工具同时在跑', async () => {
  const r = await runBatch(
    [slowTool('mcp__test__slow_a'), slowTool('mcp__test__slow_b')],
    [
      { name: 'mcp__test__slow_a', args: {}, id: 'a' },
      { name: 'mcp__test__slow_b', args: {}, id: 'b' },
    ],
  );
  assert.equal(r.max, 2, '两个只读工具应该重叠执行');
  assert.deepEqual(r.tools, ['done:mcp__test__slow_a', 'done:mcp__test__slow_b'], '结果顺序与调用一致');
});

test('串行边界：同批两个写工具保持串行', async () => {
  const r = await runBatch(
    [slowTool('mcp__test__write_a'), slowTool('mcp__test__write_b')],
    [
      { name: 'mcp__test__write_a', args: {}, id: 'a' },
      { name: 'mcp__test__write_b', args: {}, id: 'b' },
    ],
  );
  assert.equal(r.max, 1, '写操作不能并发');
  assert.deepEqual(r.order, ['mcp__test__write_a', 'mcp__test__write_b'], '顺序就是调用顺序');
  assert.deepEqual(r.tools, ['done:mcp__test__write_a', 'done:mcp__test__write_b']);
});

test('分组：只读 → 写 → 只读，写是屏障', async () => {
  const r = await runBatch(
    [slowTool('mcp__test__r1'), slowTool('mcp__test__r2'), slowTool('mcp__test__write_x'), slowTool('mcp__test__r3')],
    [
      { name: 'mcp__test__r1', args: {}, id: '1' },
      { name: 'mcp__test__r2', args: {}, id: '2' },
      { name: 'mcp__test__write_x', args: {}, id: '3' },
      { name: 'mcp__test__r3', args: {}, id: '4' },
    ],
  );
  // 第一组两个只读重叠；写单独；最后一个只读单独
  assert.equal(r.max, 2);
  assert.equal(r.order.length, 4);
  const atWrite = r.order.indexOf('mcp__test__write_x');
  const atR1 = r.order.indexOf('mcp__test__r1');
  const atR2 = r.order.indexOf('mcp__test__r2');
  const atR3 = r.order.indexOf('mcp__test__r3');
  assert.ok(atR1 >= 0 && atR2 >= 0 && atR1 < atWrite && atR2 < atWrite, '第一组只读在写之前');
  assert.ok(atR3 > atWrite, '写之后的只读在屏障之后');
  assert.deepEqual(r.tools, [
    'done:mcp__test__r1',
    'done:mcp__test__r2',
    'done:mcp__test__write_x',
    'done:mcp__test__r3',
  ]);
});
