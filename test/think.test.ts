import test from 'node:test';
import assert from 'node:assert/strict';

import {
  THINK_CANDIDATES,
  THINK_KWARGS,
  pickThinkingOff,
  thinkVerdict,
  type ThinkSample,
} from '../src/core/think.js';
import { moduleList } from '../src/core/modules.js';

function s(label: string, reasonTok: number, ok = true): ThinkSample {
  return { label, ok, inTok: 100, outTok: 50, reasonTok, costUsd: 0.0001 };
}

test('候选表：第一组是空 kwargs 的基线，label 不重复', () => {
  assert.ok(THINK_CANDIDATES.length >= 3, '候选太少，探不出什么');
  assert.deepEqual(THINK_CANDIDATES[0]!.kwargs, {}, '第一组必须是基线（什么都不传）');
  const labels = THINK_CANDIDATES.map((c) => c.label);
  assert.equal(new Set(labels).size, labels.length, 'label 重复了，账本里分不清');
  for (const c of THINK_CANDIDATES) {
    assert.ok(c.why.length > 4, `${c.label} 没写理由，候选表会变成玄学`);
    assert.ok(c.label.length > 1);
  }
});

test('判定：基线在思考 + 某一组思考为 0 → 那就是开关', () => {
  const off = pickThinkingOff([s('默认', 120), s('thinking.type=disabled', 0), s('x', 90)]);
  assert.ok(off);
  assert.equal(off!.label, 'thinking.type=disabled');
  assert.match(thinkVerdict([s('默认', 120), s('thinking.type=disabled', 0)]), /thinking\.type=disabled/);
});

test('判定：基线压根不思考 → 不硬指派一个开关', () => {
  assert.equal(pickThinkingOff([s('默认', 0), s('a', 0), s('b', 0)]), null);
  assert.match(thinkVerdict([s('默认', 0), s('a', 0)]), /本来就没有思考量/);
});

test('判定：候选都关不掉 → 老实说关不掉，并指出最低的那个', () => {
  const samples = [s('默认', 120), s('a', 80), s('b', 65)];
  assert.equal(pickThinkingOff(samples), null);
  const v = thinkVerdict(samples);
  assert.match(v, /没有候选能把思考打到 0/);
  assert.match(v, /b（65/);
});

test('判定：失败的样本不参与挑选，但全失败会说出来', () => {
  assert.equal(pickThinkingOff([s('默认', 100, false)]), null);
  assert.match(thinkVerdict([s('默认', 0, false)]), /一组都没跑通/);
  // 基线失败、后面的成功：成功的第一个顶上来当基线
  const off = pickThinkingOff([s('默认', 0, false), s('a', 100), s('b', 0)]);
  assert.equal(off?.label, 'b');
});

test('思考预算映射来自实测：off/low 关思考，high 放开', () => {
  assert.deepEqual(THINK_KWARGS.off, { thinking: { type: 'disabled' } });
  assert.deepEqual(THINK_KWARGS.low, { thinking: { type: 'disabled' } });
  assert.deepEqual(THINK_KWARGS.high, {}, 'high 放开：默认已思考全开，不必显式 enabled');
});

test('每个模块的 think 档都有映射 —— 漏了会把 undefined 塞进 modelKwargs', () => {
  for (const m of moduleList()) {
    assert.ok(m.think in THINK_KWARGS, `${m.id} 的 think=${m.think} 没有映射`);
  }
});
