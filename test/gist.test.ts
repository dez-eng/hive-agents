import test from 'node:test';
import assert from 'node:assert/strict';

import { gistFor, ruleGist, looksLikeAnswer } from '../src/core/gist.js';

test('备注复述答案时能被识别：编号开头 / 多个序号', () => {
  assert.equal(looksLikeAnswer('1. 打开登录页 2. 输入账号密码'), true);
  assert.equal(looksLikeAnswer('1、先读代码'), true);
  assert.equal(looksLikeAnswer('先看现有代码，再决定改哪一处'), false);
  assert.equal(looksLikeAnswer('拆成 4 步做准备'), false, '单个数字不算复述答案');
});

test('规则版：取最后一行有意义的内容，去掉空行', () => {
  const t = 'First line here.\n\nSecond line.\n   \nLast line wins.';
  assert.equal(ruleGist(t), 'Last line wins.');
});

test('规则版：超长截断加省略号，不吐一整段英文', () => {
  const long = 'a'.repeat(120);
  const g = ruleGist(long);
  assert.ok(g.length <= 50, `截断后不该超过 50 字，实际 ${g.length}`);
  assert.ok(g.endsWith('…'));
});

test('规则版：空正文也说清「没有正文」，不返回空字符串', () => {
  assert.equal(ruleGist('   \n  '), '（这段思考没有正文）');
});

test('HIVE_UI_GIST=0：一分钱不花，直接走规则版', async () => {
  const old = process.env.HIVE_UI_GIST;
  process.env.HIVE_UI_GIST = '0';
  try {
    const r = await gistFor({ thinking: 'We need split the task.\nThen write code.' });
    assert.equal(r.source, 'rule');
    assert.equal(r.gist, 'Then write code.');
  } finally {
    if (old === undefined) delete process.env.HIVE_UI_GIST;
    else process.env.HIVE_UI_GIST = old;
  }
});

test('空思考不进模型请求 —— 没有正文就不要花那次钱', async () => {
  const old = process.env.HIVE_UI_GIST;
  delete process.env.HIVE_UI_GIST;
  try {
    const r = await gistFor({ thinking: '   ' });
    assert.equal(r.source, 'rule');
    assert.equal(r.gist, '（这段思考没有正文）');
  } finally {
    if (old !== undefined) process.env.HIVE_UI_GIST = old;
  }
});
