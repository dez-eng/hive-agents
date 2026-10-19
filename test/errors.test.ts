/**
 * v4 M4.3：中止错误识别。零 API。
 *
 * 不同的库包装方式不同：AbortError 的 name、undici 的 code、LangGraph 的 message、
 * 以及被包在 cause 里的情况都要认出来 —— 认不出就会把「用户按了 Ctrl+C」显示成调用失败。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isAbortError, classifyError } from '../src/core/errors.js';
import { BudgetExceeded } from '../src/core/budget.js';

test('isAbortError：name / code / message / cause 四种包装都认', () => {
  assert.equal(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isAbortError(Object.assign(new Error('x'), { code: 'ABORT_ERR' })), true);
  assert.equal(isAbortError(new Error('This operation was aborted')), true);
  assert.equal(isAbortError(new Error('outer', { cause: new Error('aborted') })), true);
});

test('isAbortError：普通错误不误判', () => {
  assert.equal(isAbortError(new Error('rate limit exceeded')), false);
  assert.equal(isAbortError(new Error('401 Unauthorized')), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError('aborted'), false, '字符串不是错误对象');
});

test('isAbortError：cause 链不会无限递归（自引用）', () => {
  const e = new Error('outer');
  (e as { cause?: unknown }).cause = e;
  assert.equal(isAbortError(e), false);
});

test('classifyError：鉴权 / 限流 / 超时 / 网络 / 预算 / 策略 / 未知', () => {
  assert.equal(classifyError(Object.assign(new Error('Unauthorized'), { status: 401 })).kind, 'auth');
  assert.equal(classifyError(Object.assign(new Error('Forbidden'), { statusCode: 403 })).kind, 'auth');
  assert.equal(classifyError(Object.assign(new Error('too many requests'), { status: 429 })).kind, 'rate');
  assert.equal(classifyError(Object.assign(new Error('slow'), { code: 'ETIMEDOUT' })).kind, 'timeout');
  assert.equal(classifyError(new Error('request timed out')).kind, 'timeout');
  assert.equal(classifyError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })).kind, 'network');
  assert.equal(classifyError(new Error('fetch failed')).kind, 'network');
  assert.equal(classifyError(new BudgetExceeded(120, 100)).kind, 'budget');
  assert.equal(classifyError(new Error('被策略拒绝（规则 x = deny）')).kind, 'policy');
  assert.equal(classifyError(new Error('something odd')).kind, 'unknown');
});

test('classifyError：中止优先，且带可继续的提示', () => {
  const c = classifyError(Object.assign(new Error('x'), { name: 'AbortError' }));
  assert.equal(c.kind, 'abort');
  assert.equal(c.retryable, true);
  assert.match(c.hint ?? '', /会话还在/);
});
