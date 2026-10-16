/**
 * 账本 v3 M2 测试：三个新列 + policy 行。
 *
 * 要证明：判罚留痕能读回来、**不污染**轮次统计（/cost /turn 都按 tag='turn' 过滤）、
 * 老库（没有这三列）能补列并照读 —— 与 v2 的补列模式一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Ledger } from '../src/core/ledger.js';

function withLedger<T>(fn: (led: Ledger, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hive-led-'));
  const led = new Ledger(join(dir, 't.db'));
  led.open();
  try {
    return fn(led, dir);
  } finally {
    led.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
}

test('insertPolicy：一行 tag=policy，target/verdict/reason 都读得回来', () => {
  withLedger((led) => {
    led.insertPolicy({
      capability: 'fs',
      agent: 'B',
      target: '.hive/x.txt',
      verdict: 'deny',
      reason: '规则 agents.B.fs.write = deny',
      threadId: 'main',
    });

    const rows = led.recentPolicy(5);
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r.kind, 'policy');
    assert.equal(r.module, 'fs', 'capability id 复用 module 列');
    assert.equal(r.agent, 'B');
    assert.equal(r.target, '.hive/x.txt');
    assert.equal(r.verdict, 'deny');
    assert.ok(r.reason.includes('agents.B.fs.write'));
    assert.equal(r.costUsd, 0, '判罚不花钱');
    assert.equal(r.inTok, 0);
  });
});

test('policy 行不进轮次统计 —— 账单还是账单', () => {
  withLedger((led) => {
    led.insert({
      kind: 'turn',
      threadId: 'main',
      module: 'assistant',
      calls: 1,
      inTok: 1000,
      cacheHit: 900,
      outTok: 50,
      reasoning: 10,
      costUsd: 0.0001,
    });
    led.insertPolicy({
      capability: 'search',
      agent: 'A',
      target: 'src',
      verdict: 'allow',
      reason: '规则 agents.A.fs.read = allow',
      threadId: 'main',
    });
    led.insertPolicy({
      capability: 'fs',
      agent: 'D',
      target: 'x.ts',
      verdict: 'deny',
      reason: '规则 agents.D.fs.write = deny',
      threadId: 'main',
    });

    assert.equal(led.allTurns().length, 1, 'allTurns 只认 tag=turn');
    assert.equal(led.turnsOf('main').length, 1, '逐轮列表也只认 tag=turn');
    const totals = led.totals({ threadId: 'main' });
    assert.equal(totals?.rows, 1, '合计只算轮次');
    assert.equal(totals?.costUsd, 0.0001);
    assert.equal(led.recentPolicy(10).length, 2);
  });
});

test('允许与拒绝都留痕，且按 verdict 分得开', () => {
  withLedger((led) => {
    for (const [verdict, reason] of [
      ['allow', '规则 agents.A.fs.read = allow'],
      ['deny', '规则 agents.B.fs.write = deny'],
      ['ask-pending', '规则 agents.A.fs.write = ask'],
    ] as Array<[string, string]>) {
      led.insertPolicy({
        capability: 'fs',
        agent: 'A',
        target: 'a.ts',
        verdict,
        reason,
        threadId: 'main',
      });
    }
    const verdicts = led.recentPolicy(10).map((r) => r.verdict);
    assert.deepEqual(new Set(verdicts).size, 3);
  });
});

test('老库（没有 target/verdict/reason 列）打开后能补列并照读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-led-old-'));
  const file = join(dir, 'old.db');
  try {
    // 手工造一个「v0.1 时代」的最小表 + 一行旧账
    const db = new DatabaseSync(file);
    db.exec(
      'CREATE TABLE ledger (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL,' +
        ' run_id TEXT NOT NULL, thread_id TEXT NOT NULL, model TEXT NOT NULL,' +
        ' band TEXT NOT NULL, tag TEXT NOT NULL, calls INTEGER NOT NULL,' +
        ' in_tok INTEGER NOT NULL, cache_hit INTEGER NOT NULL, out_tok INTEGER NOT NULL,' +
        ' cost_usd REAL NOT NULL)',
    );
    db.prepare(
      'INSERT INTO ledger (ts, day, run_id, thread_id, model, band, tag, calls,' +
        ' in_tok, cache_hit, out_tok, cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run('2026-01-01 00:00:00', '2026-01-01', 'r1', 'main', 'deepseek-flash', 'off', 'turn', 1, 100, 0, 20, 0.0002);
    db.close();

    const led = new Ledger(file);
    assert.equal(led.open(), true);

    const rows = led.recent(5);
    assert.equal(rows.length, 1, '旧行照读');
    assert.equal(rows[0]!.inTok, 100);
    assert.equal(rows[0]!.target, '', '新列给空串，不是 undefined');
    assert.equal(rows[0]!.verdict, '');

    // 补列之后还能正常写 policy 行与轮次
    led.insertPolicy({
      capability: 'search',
      agent: 'A',
      target: 'src',
      verdict: 'allow',
      reason: 'ok',
      threadId: 'main',
    });
    assert.equal(led.recentPolicy(5).length, 1);
    assert.equal(led.recent(10).length, 2, '旧行 + policy 行都在表里');
    assert.equal(led.totals()?.rows, 1, '账单只算旧那行 —— policy 不是消费');
    assert.equal(led.allTurns().length, 1, '轮次也只认旧的那行');
    led.close();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
});
