/**
 * 进程内任务注册表的零 API 测试（v4 M4.1 的 /tasks 数据源）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { TaskRegistry } from '../src/core/tasks.js';
import type { HandoffResult } from '../src/core/handoff.js';

function res(over: Partial<HandoffResult> = {}): HandoffResult {
  return { taskId: 't1', ok: true, tokens: 120, costUsd: 0.0001, budgetHit: false, ...over };
}

function start(reg: TaskRegistry, taskId = 't1') {
  return reg.start({ taskId, from: 'A', to: 'C', goal: '改 a', budgetTokens: 200 });
}

test('start/finish：完成、熔断、拒绝、失败四种状态', () => {
  const reg = new TaskRegistry();
  start(reg, 'ok');
  reg.finish('ok', res({ taskId: 'ok' }));
  assert.equal(reg.list()[0]!.state, 'done');
  assert.equal(reg.list()[0]!.tokens, 120);

  start(reg, 'hot');
  reg.finish('hot', res({ taskId: 'hot', budgetHit: true, notes: '被预算闸门熔断' }));
  assert.equal(reg.list()[0]!.state, 'budget');

  start(reg, 'no');
  reg.finish('no', res({ taskId: 'no', ok: false, notes: '令牌 x 预算不足（并发预留失败）' }));
  assert.equal(reg.list()[0]!.state, 'denied');

  start(reg, 'bad');
  reg.finish('bad', res({ taskId: 'bad', ok: false, notes: '模型抽风' }));
  assert.equal(reg.list()[0]!.state, 'failed');

  start(reg, 'boom');
  reg.fail('boom', '执行核抛错');
  assert.equal(reg.list()[0]!.state, 'failed');
  assert.equal(reg.list()[0]!.notes, '执行核抛错');
});

test('续跑同一 taskId：不重复占位，状态更新为最新一轮', () => {
  const reg = new TaskRegistry();
  start(reg, 't1');
  reg.finish('t1', res({ taskId: 't1', tokens: 120 }));
  start(reg, 't1'); // 续跑
  assert.equal(reg.list().length, 1, '同一 task 只占一个位置');
  assert.equal(reg.list()[0]!.state, 'running');
  reg.finish('t1', res({ taskId: 't1', tokens: 240 }));
  assert.equal(reg.list()[0]!.tokens, 240, '显示最新一轮');
});

test('新的在前；running() 只挑运行中的', () => {
  const reg = new TaskRegistry();
  start(reg, 'a');
  reg.finish('a', res({ taskId: 'a' }));
  start(reg, 'b');
  assert.deepEqual(reg.list().map((t) => t.taskId), ['b', 'a']);
  assert.deepEqual(reg.running().map((t) => t.taskId), ['b']);
});

test('有界：超过上限先丢最老的', () => {
  const reg = new TaskRegistry(3);
  for (const id of ['a', 'b', 'c', 'd']) {
    start(reg, id);
    reg.finish(id, res({ taskId: id }));
  }
  assert.deepEqual(reg.list().map((t) => t.taskId), ['d', 'c', 'b']);
});

test('clear 清空（测试与 /new 用）', () => {
  const reg = new TaskRegistry();
  start(reg);
  reg.clear();
  assert.equal(reg.list().length, 0);
});
