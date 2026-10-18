import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Ledger, head, kBlocksOf, missOf } from '../src/core/ledger.js';

const requireNative = createRequire(import.meta.url);

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

// ── v3 M3：可续会话的账本支撑 + 按身份核账 ─────────────────

test('findHandoff：同一 task 多次交接取最近一条，thread 读得回来', () => {
  const { ledger, dir } = tempLedger();
  try {
    const base = {
      taskId: 't001-aaaa',
      from: 'A',
      to: 'C',
      expect: 'diff',
      budgetTok: 100,
      tokens: 10,
      costUsd: 0.001,
      ok: true,
      budgetHit: false,
      thread: 'main#C#t001-aaaa',
    };
    ledger.insertHandoff({ ...base, goal: '首跑' });
    ledger.insertHandoff({ ...base, goal: '[续跑] 再看一下' });

    const rec = ledger.findHandoff('t001-aaaa');
    assert.ok(rec);
    assert.equal(rec!.goal, '[续跑] 再看一下', '最近一条');
    assert.equal(rec!.thread, 'main#C#t001-aaaa');
    assert.equal(rec!.from, 'A');
    assert.equal(rec!.to, 'C');

    assert.equal(ledger.findHandoff('不存在'), null);
    assert.equal(ledger.handoffTotals('t001-aaaa')!.rows, 2);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('老库 handoffs 没有 thread 列 → 打开后补列，旧行 thread 为空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-old-'));
  const path = join(dir, 'old.db');
  try {
    const sqlite = requireNative('node:sqlite') as {
      DatabaseSync: new (p: string) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...args: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new sqlite.DatabaseSync(path);
    db.exec(`
      CREATE TABLE handoffs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     TEXT    NOT NULL,
        ts          TEXT    NOT NULL,
        day         TEXT    NOT NULL,
        from_agent  TEXT    NOT NULL,
        to_agent    TEXT    NOT NULL,
        goal        TEXT    NOT NULL DEFAULT '',
        expect      TEXT    NOT NULL DEFAULT '',
        budget_tok  INTEGER NOT NULL DEFAULT 0,
        tokens      INTEGER NOT NULL DEFAULT 0,
        cost_usd    REAL    NOT NULL DEFAULT 0,
        ok          INTEGER NOT NULL DEFAULT 1,
        budget_hit  INTEGER NOT NULL DEFAULT 0,
        notes       TEXT    NOT NULL DEFAULT '',
        output_head TEXT    NOT NULL DEFAULT ''
      )
    `);
    db.prepare(
      'INSERT INTO handoffs (task_id, ts, day, from_agent, to_agent, goal)' +
        ' VALUES (?,?,?,?,?,?)',
    ).run('old-1', '2026-01-01T00:00:00', '2026-01-01', 'A', 'C', '老任务');
    db.close();

    const led = new Ledger(path);
    assert.ok(led.open(), '老库应该能打开并补列');
    const rec = led.findHandoff('old-1');
    assert.ok(rec);
    assert.equal(rec!.goal, '老任务');
    assert.equal(rec!.thread, '', '老行没有 thread —— 续跑要明确拒绝，不猜');
    led.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('byAgent：按身份汇总，policy 行不混进账单', () => {
  const { ledger, dir } = tempLedger();
  try {
    const turn = (agent: string, inTok: number, costUsd: number, threadId = 'main') =>
      ledger.insert({
        kind: 'turn',
        threadId,
        module: agent === 'C' ? 'fix' : 'assistant',
        calls: 1,
        inTok,
        cacheHit: inTok - 100,
        outTok: 10,
        reasoning: 5,
        costUsd,
        agent,
        ...(agent === 'C' ? { taskId: 't001-aaaa' } : {}),
      });

    turn('A', 1000, 0.001);
    turn('A', 500, 0.0005);
    turn('C', 2000, 0.002, 'main#C#t001-aaaa');
    ledger.insertPolicy({
      capability: 'fs',
      agent: 'C',
      target: 'C:/outside',
      verdict: 'deny',
      reason: '越界',
    });

    const rows = ledger.byAgent();
    assert.equal(rows.length, 2, '只有 A/C 两个身份，policy 行不出现');
    const a = rows.find((r) => r.agent === 'A')!;
    const c = rows.find((r) => r.agent === 'C')!;
    assert.equal(a.rows, 2);
    assert.equal(a.inTok, 1500);
    assert.equal(a.cacheHit, 1300);
    assert.ok(Math.abs(a.costUsd - 0.0015) < 1e-12);
    assert.equal(c.rows, 1);
    assert.equal(c.inTok, 2000);
    assert.equal(c.calls, 1);
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
