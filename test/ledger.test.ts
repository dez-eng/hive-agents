import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ledger, head, kBlocksOf, missOf } from '../src/core/ledger.js';

function tempLedger(): { ledger: Ledger; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hive-test-'));
  const ledger = new Ledger(join(dir, 'costs.db'), 'testrun1');
  assert.ok(ledger.open(), '账本应该能打开');
  return { ledger, dir };
}

test('missOf / kBlocksOf 与几何律一致', () => {
  assert.equal(missOf(7354, 7168), 186);
  assert.equal(kBlocksOf(7354, 7168), 2);
  assert.equal(missOf(100, 100), 0);
  assert.equal(kBlocksOf(100, 100), 0);
});

test('head 把多行压成一行并截断', () => {
  assert.equal(head('a\nb\nc', 10), 'a b c');
  assert.equal(head('x'.repeat(100), 5), 'xxxxx');
});

test('写入后能按会话取回，序号与调用次数都在', () => {
  const { ledger, dir } = tempLedger();
  try {
    for (let i = 1; i <= 3; i += 1) {
      ledger.insert({
        kind: 'turn',
        threadId: 'main',
        module: 'assistant',
        calls: 1,
        inTok: 7000 + i,
        cacheHit: 6800 + i,
        outTok: 100 * i,
        reasoning: 90 * i,
        costUsd: 0.0001 * i,
        userChars: 5,
        userHead: `问题${i}`,
        outHead: `答案${i}`,
        styleOn: 1,
        band: 'off',
      });
    }
    const rows = ledger.turnsOf('main');
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.userHead, '问题1');
    assert.equal(rows[2]!.outTok, 300);
    assert.equal(rows[0]!.styleOn, 1);
    assert.equal(rows[0]!.module, 'assistant');
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('区间查询：/turn N-M 的底层切片', () => {
  const { ledger, dir } = tempLedger();
  try {
    for (let i = 1; i <= 5; i += 1) {
      ledger.insert({
        kind: 'turn',
        threadId: 'main',
        module: 'calc',
        calls: 1,
        inTok: 1000,
        cacheHit: 900,
        outTok: 10,
        reasoning: 0,
        costUsd: 0.00001,
        userHead: `t${i}`,
      });
    }
    const rows = ledger.turnsOf('main');
    const slice = rows.slice(1, 4);
    assert.equal(slice.length, 3);
    const cost = slice.reduce((a, r) => a + r.costUsd, 0);
    assert.ok(Math.abs(cost - 0.00003) < 1e-12);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('按词搜索问答正文', () => {
  const { ledger, dir } = tempLedger();
  try {
    ledger.insert({
      kind: 'turn',
      threadId: 'main',
      module: 'assistant',
      calls: 1,
      inTok: 900,
      cacheHit: 800,
      outTok: 20,
      reasoning: 0,
      costUsd: 0.00002,
      userHead: '帮我看看内网穿透的配置',
      outHead: '要看哪个文件',
    });
    ledger.insert({
      kind: 'turn',
      threadId: 'main',
      module: 'assistant',
      calls: 1,
      inTok: 950,
      cacheHit: 850,
      outTok: 20,
      reasoning: 0,
      costUsd: 0.00002,
      userHead: '今天天气',
      outHead: '不知道',
    });
    assert.equal(ledger.search('穿透').length, 1);
    assert.equal(ledger.search('不存在的东西').length, 0);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('totals 能按 run 和按会话分别统计', () => {
  const { ledger, dir } = tempLedger();
  try {
    ledger.insert({
      kind: 'turn',
      threadId: 'a',
      module: 'assistant',
      calls: 1,
      inTok: 1000,
      cacheHit: 900,
      outTok: 10,
      reasoning: 5,
      costUsd: 0.0001,
    });
    ledger.insert({
      kind: 'turn',
      threadId: 'b',
      module: 'assistant',
      calls: 2,
      inTok: 2000,
      cacheHit: 1800,
      outTok: 20,
      reasoning: 10,
      costUsd: 0.0002,
    });
    const all = ledger.totals();
    assert.equal(all?.rows, 2);
    assert.equal(all?.inTok, 3000);
    assert.equal(all?.calls, 3);
    const onlyA = ledger.totals({ threadId: 'a' });
    assert.equal(onlyA?.rows, 1);
    assert.equal(onlyA?.outTok, 10);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('打不开路径时不抛异常，只是不落盘', () => {
  const ledger = new Ledger('\u0000bad\u0000path/costs.db');
  const ok = ledger.open();
  assert.equal(typeof ok, 'boolean');
  ledger.close();
});
