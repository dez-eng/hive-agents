/**
 * 上下文压缩测试（v3 M2.5）。零 API —— 纯函数，根本不碰模型。
 *
 * 要证明：没过阈值一条不动；超了才压且切点落在轮边界（不会把 tool_calls 与回包拆散）；
 * 摘要剥掉角色片、且**确定性**（同样输入永远同样输出，否则每轮都在改中段 = 每轮全作废）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';

import { SUMMARY_HEAD, compactMessages, renderSummary } from '../src/core/agent.js';

const q = (text: string): HumanMessage => new HumanMessage(text);
const a = (text: string): AIMessage => new AIMessage(text);

test('没过阈值：一条都不动（原样返回同一个引用）', () => {
  const msgs = [q('一'), a('1'), q('二'), a('2')];
  const r = compactMessages(msgs, { at: 24000, keep: 2, lastInTok: 100 });
  assert.equal(r.dropped, 0);
  assert.equal(r.summary, null);
  assert.equal(r.messages, msgs);
});

test('显式关闭：at=0 或 keep=0 时从不压', () => {
  const msgs = [q('一'), a('1'), q('二'), a('2')];
  assert.equal(compactMessages(msgs, { at: 0, keep: 2, lastInTok: 9_999_999 }).dropped, 0);
  assert.equal(compactMessages(msgs, { at: 100, keep: 0, lastInTok: 9_999_999 }).dropped, 0);
});

test('条数不够也不压（没东西可丢）', () => {
  const msgs = [q('一'), a('1')];
  assert.equal(compactMessages(msgs, { at: 100, keep: 16, lastInTok: 9_999_999 }).dropped, 0);
});

test('超阈值：压掉旧轮次，摘要头在最前，条数对得上', () => {
  const msgs = Array.from({ length: 12 }, (_, i) => [q(`问 ${i}`), a(`答 ${i}`)]).flat();
  const r = compactMessages(msgs, { at: 100, keep: 8, lastInTok: 30000 });

  assert.ok(r.dropped > 0, '该压了');
  assert.equal(r.messages.length, msgs.length - r.dropped + 1, '压掉 N 条，加一条摘要');
  assert.equal(r.messages[0]!.getType(), 'human');
  assert.ok(String(r.messages[0]!.content).startsWith(SUMMARY_HEAD));
  assert.ok(r.summary);
});

test('切点必须落在轮边界：保留段不能以工具回包开头', () => {
  const msgs = [
    q('一'),
    a('1'),
    q('二'),
    a('2'),
    q('三'),
    new AIMessage({
      content: '',
      tool_calls: [{ name: 'calculator', args: { expression: '1+1' }, id: 't1' }],
    }),
    new ToolMessage({ content: '2', tool_call_id: 't1' }),
    a('是 2'),
  ];
  const r = compactMessages(msgs, { at: 100, keep: 4, lastInTok: 50000 });
  const kept = r.messages.slice(1); // 去掉摘要头
  assert.equal(kept[0]!.getType(), 'human', '保留段必须以用户消息开头');
  assert.notEqual(kept[0]!.getType(), 'tool', '以工具回包开头就说明 tool_calls 被切掉了');
});

test('摘要确定性：同一段输入连压两次结果逐字一致', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => [q(`问 ${i}`), a(`答 ${i}`)]).flat();
  const r1 = compactMessages(msgs, { at: 100, keep: 6, lastInTok: 30000 });
  const r2 = compactMessages(msgs, { at: 100, keep: 6, lastInTok: 30000 });
  assert.equal(r1.summary, r2.summary);
});

test('摘要内容：剥掉角色片、只留问句与答句；已经是摘要的不会再摘要一遍', () => {
  const s = renderSummary([
    q('帮我改一下代码\n\n【模块:fix｜修复】只改这一行'),
    a('改好了'),
  ]);
  assert.ok(s.includes('帮我改一下代码'), s);
  assert.ok(!s.includes('【模块:'), `角色片不该进摘要：${s}`);
  assert.ok(s.includes('改好了'), s);

  const again = renderSummary([new HumanMessage(`${SUMMARY_HEAD}（压掉 3 条消息）\n· 问「x」→ 答「y」`)]);
  assert.ok(!again.includes('· 问「[已压缩'), `不该把摘要当问题再摘一遍：${again}`);
});

test('摘要行数有上限（不会把丢掉的几千字又搬回来）', () => {
  const msgs = Array.from({ length: 60 }, (_, i) => [q(`问 ${i}`), a(`答 ${i}`)]).flat();
  const s = renderSummary(msgs);
  const lines = s.split('\n');
  assert.ok(lines.length <= 22, `摘要 ${lines.length} 行，超了`);
  assert.ok(s.includes('省略'), s);
});
