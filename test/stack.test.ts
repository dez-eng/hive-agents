import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stackDepth,
  stackLabel,
  stackPop,
  stackPush,
  stackTop,
} from '../src/core/stack.js';
import { AGENTS, MODULES, agentOf, mayDelegate, moduleList } from '../src/core/modules.js';
import { currentAgent, currentModuleId, newReplState } from '../src/core/session.js';

test('压栈 / 弹栈：栈底永不弹出 —— 弹出去了就没有当前角色了', () => {
  let s: string[] = ['assistant'];
  assert.equal(stackDepth(s), 1);
  assert.deepEqual(stackPop(s), ['assistant'], '只有一层时不该被弹空');
  s = stackPush(s, 'recon');
  assert.equal(stackTop(s), 'recon');
  assert.equal(stackDepth(s), 2);
  s = stackPop(s);
  assert.equal(stackTop(s), 'assistant');
  assert.equal(stackDepth(s), 1);
});

test('栈式恢复：B 借调 C，C 干完弹回 B，B 干完弹回 A', () => {
  let s: string[] = ['assistant']; // A
  s = stackPush(s, 'recon'); // A 借调 B
  s = stackPush(s, 'fix'); // B 借调 C
  assert.equal(stackTop(s), 'fix');
  s = stackPop(s); // C 干完
  assert.equal(stackTop(s), 'recon', '必须弹回 B，而不是覆盖掉');
  s = stackPop(s); // B 干完
  assert.equal(stackTop(s), 'assistant');
});

test('栈标签给人看：通用›侦察›修复', () => {
  const label = (id: string): string => MODULES[id]?.title ?? id;
  assert.equal(stackLabel(['assistant', 'recon', 'fix'], label), '通用›侦察›修复');
});

test('会话状态：默认栈只有 A 的主模块', () => {
  const st = newReplState('t1');
  assert.deepEqual(st.stack, ['assistant']);
  assert.equal(currentModuleId(st), 'assistant');
  assert.equal(currentAgent(st), 'A');
});

test('切层不动 thread —— 换模块不是换会话（缓存不会因此作废）', () => {
  const st = newReplState('t1');
  st.stack = stackPush(st.stack, 'recon');
  assert.equal(st.thread, 't1');
  assert.equal(currentAgent(st), 'B');
});

test('每个模块都归属一个 agent，且 AGENTS 的主模块真实存在', () => {
  for (const m of moduleList()) {
    assert.ok(m.owner, `${m.id} 没写 owner`);
    assert.ok(AGENTS[m.owner]!, `${m.id} 的 owner ${m.owner} 不在 AGENTS 表里`);
  }
  for (const a of Object.values(AGENTS)) {
    assert.ok(MODULES[a.home], `${a.id} 的主模块 ${a.home} 不存在`);
    assert.equal(agentOf(a.home), a.id, `${a.home} 的 owner 与 ${a.id} 对不上`);
  }
});

test('借调白名单：A 可调 B/C/D，B 可调 C/D，C/D 只能自己干', () => {
  const expect: Record<string, string[]> = {
    A: ['B', 'C', 'D'],
    B: ['C', 'D'],
    C: [],
    D: [],
  };
  for (const [id, allowed] of Object.entries(expect)) {
    assert.deepEqual(AGENTS[id as 'A'].mayCall, allowed, `${id} 的 mayCall 不对`);
  }
  assert.ok(mayDelegate('A', 'B'));
  assert.ok(mayDelegate('B', 'C'));
  assert.ok(!mayDelegate('C', 'B'), 'C 不该能借调任何人');
  assert.ok(!mayDelegate('B', 'A'), '副 agent 不该能借调主控');
});
