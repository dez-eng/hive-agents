import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBalance, resetBalanceCache, knownBalance, knownBalanceAt } from '../src/core/balance.js';

test('余额解析：取第一条 balance_info 的 total_balance', () => {
  const b = parseBalance({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00' }],
  });
  assert.deepEqual(b, { amount: 110, currency: 'CNY' });
});

test('余额解析：响应格式变了就返回 null，不要瞎猜一个数', () => {
  assert.equal(parseBalance(null), null);
  assert.equal(parseBalance({}), null);
  assert.equal(parseBalance({ balance_infos: [] }), null);
  assert.equal(parseBalance({ balance_infos: [{ total_balance: 'not-a-number' }] }), null);
});

test('余额解析：没有 currency 时回落到 CNY（DeepSeek 人民币账户）', () => {
  assert.deepEqual(parseBalance({ balance_infos: [{ total_balance: '1.50' }] }), {
    amount: 1.5,
    currency: 'CNY',
  });
});

test('没查过余额时是 null，不是 0 —— 0 会被当成「钱花光了」', () => {
  resetBalanceCache();
  assert.equal(knownBalance(), null);
  assert.equal(knownBalanceAt(), null);
});
