import test from 'node:test';
import assert from 'node:assert/strict';

import { TokenMeter, extractUsage } from '../src/core/meter.js';

test('usage_metadata 标准位能读出来', () => {
  const s = extractUsage({
    usage_metadata: {
      input_tokens: 7354,
      output_tokens: 186,
      input_token_details: { cache_read: 7168 },
      output_token_details: { reasoning: 100 },
    },
  });
  assert.equal(s.calls, 1);
  assert.equal(s.inTok, 7354);
  assert.equal(s.outTok, 186);
  assert.equal(s.cacheHit, 7168);
  assert.equal(s.reasoning, 100);
});

test('DeepSeek 把命中量塞在 response_metadata.tokenUsage 里也认', () => {
  const s = extractUsage({
    response_metadata: {
      tokenUsage: {
        prompt_tokens: 7354,
        completion_tokens: 186,
        prompt_cache_hit_tokens: 7168,
        completion_tokens_details: { reasoning_tokens: 106 },
      },
    },
  });
  assert.equal(s.inTok, 7354);
  assert.equal(s.cacheHit, 7168);
  assert.equal(s.reasoning, 106);
});

test('两层都没给时回落到 llmOutput', () => {
  const s = extractUsage(undefined, {
    tokenUsage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 64 },
  });
  assert.equal(s.inTok, 100);
  assert.equal(s.cacheHit, 64);
});

test('什么都没有时是 0，不是 NaN', () => {
  const s = extractUsage(undefined, undefined);
  assert.equal(s.inTok, 0);
  assert.equal(s.calls, 1);
});

test('几何律：未命中 = (入 mod 64) + 64k', () => {
  const m = new TokenMeter({ model: 'deepseek-flash', band: 'off' });
  // 6.7 的实测样本：入 7,354 余 58，未命中 186 → k = 2
  m.absorb({ calls: 1, inTok: 7354, cacheHit: 7354 - 186, outTok: 10, reasoning: 0 });
  assert.equal(m.missTok(), 186);
  assert.equal(m.inTok % 64, 58);
  assert.equal(m.kBlocks(), 2);
});

test('另一个余数、同一个余额 —— 也是 k=2', () => {
  const m = new TokenMeter({ model: 'deepseek-flash', band: 'off' });
  // 入 7,320 余 24，未命中 152 → 余额 128 = 2×64
  m.absorb({ calls: 1, inTok: 7320, cacheHit: 7320 - 152, outTok: 4, reasoning: 0 });
  assert.equal(m.missTok(), 152);
  assert.equal(m.inTok % 64, 24);
  assert.equal(m.kBlocks(), 2);
});

test('可见输出 = 输出 − 思考', () => {
  const m = new TokenMeter({ model: 'deepseek-flash', band: 'off' });
  m.absorb({ calls: 1, inTok: 1000, cacheHit: 900, outTok: 120, reasoning: 115 });
  assert.equal(m.visibleTok(), 5);
});

test('成本按未命中/命中/输出三段相加', () => {
  const m = new TokenMeter({ model: 'deepseek-flash', band: 'off' });
  m.absorb({ calls: 1, inTok: 7354, cacheHit: 7168, outTok: 186, reasoning: 0 });
  // 186/1e6*0.15 + 7168/1e6*0.003 + 186/1e6*0.6
  const expected = (186 / 1e6) * 0.15 + (7168 / 1e6) * 0.003 + (186 / 1e6) * 0.6;
  assert.ok(Math.abs(m.cost() - expected) < 1e-12, `${m.cost()} != ${expected}`);
});

test('峰时比谷时贵一倍', () => {
  const off = new TokenMeter({ model: 'deepseek-flash', band: 'off' });
  const peak = new TokenMeter({ model: 'deepseek-flash', band: 'peak' });
  for (const m of [off, peak]) {
    m.absorb({ calls: 1, inTok: 1000, cacheHit: 500, outTok: 100, reasoning: 0 });
  }
  assert.ok(Math.abs(peak.cost() - off.cost() * 2) < 1e-12);
});

test('工具轮累加多次调用', () => {
  const m = new TokenMeter({ model: 'deepseek-flash', band: 'off' });
  m.absorb({ calls: 1, inTok: 1000, cacheHit: 900, outTok: 20, reasoning: 0 });
  m.absorb({ calls: 1, inTok: 1200, cacheHit: 1000, outTok: 30, reasoning: 10 });
  assert.equal(m.calls, 2);
  assert.equal(m.inTok, 2200);
  assert.equal(m.missTok(), 300);
});
