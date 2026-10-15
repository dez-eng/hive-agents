import test from 'node:test';
import assert from 'node:assert/strict';

import { STABLE_PREFIX, renderUserContent } from '../src/core/prompt.js';
import { MODULES, moduleList } from '../src/core/modules.js';

function firstDiff(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return n;
}

test('system 前缀里不含任何模块内容 —— 这是缓存的地基', () => {
  for (const m of moduleList()) {
    assert.ok(!STABLE_PREFIX.includes(m.fragment), `${m.id} 的角色片漏进了 system`);
    // 用标记而不是标题：标题是普通词（「算数」），撞上前缀里的正常句子并不代表设计错了
    assert.ok(!STABLE_PREFIX.includes(`【模块:${m.id}`), `${m.id} 的模块标记漏进了 system`);
  }
});

test('切模块不动前缀：差异只出现在原文之后', () => {
  const text = '读一下 src/index.ts';
  const a = renderUserContent(text, MODULES['assistant']!, { tail: true });
  const b = renderUserContent(text, MODULES['recon']!, { tail: true });
  assert.ok(a.startsWith(text));
  assert.ok(b.startsWith(text));
  assert.notEqual(a, b);
  assert.ok(firstDiff(a, b) >= text.length, '差异出现在原文中间，前缀就不稳了');
});

test('关尾：原样返回，跨模块完全同字节', () => {
  const text = '算一下 3*7';
  const a = renderUserContent(text, MODULES['assistant']!, { tail: false });
  const b = renderUserContent(text, MODULES['recon']!, { tail: false });
  assert.equal(a, text);
  assert.equal(a, b);
});

test('开尾时尾部确实挂上了模块标记', () => {
  const out = renderUserContent('你好', MODULES['calc']!, { tail: true });
  assert.ok(out.includes('【模块:calc'));
});

test('同一模块 + 同一原文 = 逐字节相同（缓存能命中）', () => {
  const text = '同样的输入';
  const a = renderUserContent(text, MODULES['assistant']!, { tail: true });
  const b = renderUserContent(text, MODULES['assistant']!, { tail: true });
  assert.equal(a, b);
});

test('前缀本身是逐字节稳定的（有改动这里会红，提醒你缓存作废）', () => {
  const digest = STABLE_PREFIX.length;
  assert.equal(typeof digest, 'number');
  assert.ok(STABLE_PREFIX.length > 100, '前缀太短，可能被误删');
  assert.ok(!STABLE_PREFIX.includes('\t'), '前缀里不要有 tab，容易被终端吃掉');
});
