import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_TTL_MS,
  authorizeDelegate,
  checkToken,
  debitToken,
  issueToken,
  remaining,
  type Token,
} from '../src/core/grant.js';
import {
  makeTaskId,
  parseHandoffInput,
  parseHandoffResult,
  subThread,
} from '../src/core/handoff.js';
import { Ledger } from '../src/core/ledger.js';

const NOW = 1_700_000_000_000;

function tok(to: 'B' | 'C' | 'D' = 'B', budget = 1000, now = NOW): Token {
  const r = issueToken(to, { budgetTokens: budget, now });
  assert.ok(r.ok);
  return (r as { ok: true; token: Token }).token;
}

test('签发：只有 A 能签，也不能签给自己', () => {
  const byB = issueToken('C', { issuedBy: 'B', budgetTokens: 100 });
  assert.equal(byB.ok, false);
  assert.match((byB as { reason: string }).reason, /只有 A/);

  const toA = issueToken('A', { budgetTokens: 100 });
  assert.equal(toA.ok, false);

  const bad = issueToken('B', { budgetTokens: -1 });
  assert.equal(bad.ok, false);
});

test('签发：mayCall 从身份表取 —— 借调白名单不是调用点上临时商量的', () => {
  const t = tok('B', 1000);
  assert.deepEqual(t.mayCall, ['C', 'D']);
  assert.equal(t.spent, 0);
  assert.equal(t.expiresAt - t.issuedAt, DEFAULT_TTL_MS);
  assert.equal(remaining(t), 1000);
});

test('checkToken：不在 mayCall 里 → 拒', () => {
  const t = tok('C', 1000); // C 的 mayCall 是空的
  const v = checkToken(t, 'D', 10, NOW);
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /mayCall/);
});

test('checkToken：过期 → 拒', () => {
  const t = tok('B', 1000);
  assert.equal(checkToken(t, 'C', 10, NOW + 1).ok, true);
  const late = checkToken(t, 'C', 10, NOW + DEFAULT_TTL_MS + 1);
  assert.equal(late.ok, false);
  assert.match((late as { reason: string }).reason, /过期/);
});

test('checkToken：超预算 → 拒（剩余 + 本次 > 上限）', () => {
  const t = debitToken(tok('B', 100), 90);
  assert.equal(remaining(t), 10);
  assert.equal(checkToken(t, 'C', 10, NOW).ok, true, '刚好用满应该放行');
  const over = checkToken(t, 'C', 11, NOW);
  assert.equal(over.ok, false);
  assert.match((over as { reason: string }).reason, /超预算/);
});

test('debitToken 不可变 —— 记一笔不会改到别人手上的那张', () => {
  const a = tok('B', 100);
  const b = debitToken(a, 30);
  assert.equal(a.spent, 0);
  assert.equal(b.spent, 30);
  assert.notEqual(a, b);
});

test('执行层总闸：身份表先挡，再谈令牌', () => {
  const none = authorizeDelegate({ from: 'C', to: 'B', token: tok('C', 100), needTokens: 1, now: NOW });
  assert.equal(none.ok, false);
  assert.match((none as { reason: string }).reason, /无权借调/);

  const self = authorizeDelegate({ from: 'B', to: 'B', token: null, needTokens: 1, now: NOW });
  assert.equal(self.ok, false);
  assert.match((self as { reason: string }).reason, /自己/);

  const noToken = authorizeDelegate({ from: 'B', to: 'C', token: null, needTokens: 1, now: NOW });
  assert.equal(noToken.ok, false);
  assert.match((noToken as { reason: string }).reason, /需要令牌/);
});

test('执行层总闸：令牌必须是 A 签给本人的', () => {
  const forged: Token = { ...tok('B', 100), issuedBy: 'B' as Token['issuedBy'] };
  const v1 = authorizeDelegate({ from: 'B', to: 'C', token: forged, needTokens: 1, now: NOW });
  assert.equal(v1.ok, false);
  assert.match((v1 as { reason: string }).reason, /只能由 A 签发/);

  const other = tok('D', 100); // D 的令牌给了别人
  const v2 = authorizeDelegate({ from: 'B', to: 'C', token: other, needTokens: 1, now: NOW });
  assert.equal(v2.ok, false);
  assert.match((v2 as { reason: string }).reason, /属于 D/);
});

test('执行层总闸：正常借调放行 —— A 签给 B，B 调 C', () => {
  const v = authorizeDelegate({ from: 'B', to: 'C', token: tok('B', 500), needTokens: 200, now: NOW });
  assert.equal(v.ok, true);
});

test('交接 schema：合法的过，非法的给出人话原因', () => {
  const ok = parseHandoffInput({
    taskId: 't001-abcd',
    from: 'B',
    to: 'C',
    goal: '修掉这一处越界读',
    slice: 'src/core/tools.ts:42 前缀比较要带分隔符',
    expect: '改后的 diff',
    budgetTokens: 800,
  });
  assert.equal(ok.ok, true);

  const bad = parseHandoffInput({ taskId: '', from: 'X', to: 'C' });
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /taskId|from/);
});

test('交接 schema：不是原文通道 —— 字段里没有「历史」「原文」这类入口', () => {
  const keys = Object.keys(
    (parseHandoffResult({ taskId: 't1', ok: true, tokens: 3, costUsd: 0, budgetHit: false }) as
      | { ok: true; value: Record<string, unknown> }
      | { ok: false }),
    // 占位，真正的断言在下一行
  );
  assert.ok(Array.isArray(keys));
  const r = parseHandoffResult({ taskId: 't1', ok: true, tokens: 3, costUsd: 0, budgetHit: false });
  assert.equal(r.ok, true);
  assert.ok(!('history' in (r as { value: Record<string, unknown> }).value));
});

test('子任务 id 与子会话 thread：与主 thread 物理隔离', () => {
  const id = makeTaskId(3, 'abcd');
  assert.equal(id, 't003-abcd');
  assert.equal(subThread('main', 'C', id), 'main#C#t003-abcd');
  assert.notEqual(subThread('main', 'C', id), 'main');
});

test('账本：v2 四列写进去读得回来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-ledger-v2-'));
  const led = new Ledger(join(dir, 't.db'));
  try {
    assert.equal(led.open(), true);
    led.insert({
      kind: 'turn',
      threadId: 'main#C#t001-aaaa',
      module: 'fix',
      calls: 1,
      inTok: 100,
      cacheHit: 64,
      outTok: 20,
      reasoning: 5,
      costUsd: 0.0001,
      agent: 'C',
      taskId: 't001-aaaa',
      budgetTok: 800,
      budgetHit: 0,
    });
    const rows = led.turnsOfTask('t001-aaaa');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.agent, 'C');
    assert.equal(rows[0]!.taskId, 't001-aaaa');
    assert.equal(rows[0]!.budgetTok, 800);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('账本：令牌落库、取回、过期的不出现在 liveTokens 里', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-ledger-tok-'));
  const led = new Ledger(join(dir, 't.db'));
  try {
    assert.equal(led.open(), true);
    const live = tok('B', 500);
    const old = issueToken('B', { budgetTokens: 500, now: NOW, ttlMs: 1000 });
    assert.ok(old.ok);
    led.saveToken(live);
    led.saveToken((old as { ok: true; token: Token }).token);

    const back = led.loadToken(live.id);
    assert.ok(back);
    assert.deepEqual(back!.mayCall, ['C', 'D']);
    assert.equal(back!.budgetTokens, 500);

    const only = led.liveTokens('B', NOW + 5000);
    assert.equal(only.length, 1, '过期那张不该出现在有效令牌里');
    assert.equal(only[0]!.id, live.id);

    led.updateTokenSpent(live.id, 120);
    assert.equal(led.loadToken(live.id)!.spent, 120);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('账本：交接记录写进去、按 task 汇总得出来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-ledger-ho-'));
  const led = new Ledger(join(dir, 't.db'));
  try {
    assert.equal(led.open(), true);
    const id = makeTaskId(1, 'beef');
    led.insertHandoff({
      taskId: id,
      from: 'B',
      to: 'C',
      goal: '修越界读',
      expect: 'diff',
      budgetTok: 800,
      tokens: 320,
      costUsd: 0.00042,
      ok: true,
      budgetHit: false,
      output: '改好了',
    });
    const recent = led.recentHandoffs(5);
    assert.equal(recent.length, 1);
    assert.equal(recent[0]!.taskId, id);
    assert.equal(recent[0]!.from, 'B');
    assert.equal(recent[0]!.ok, true);

    const t = led.handoffTotals(id);
    assert.ok(t);
    assert.equal(t!.tokens, 320);
    assert.equal(t!.rows, 1);
  } finally {
    led.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('执行层总闸：A 是签发者，自带权限 —— 无需令牌', () => {
  // §4：借调默认由 A 自行决定。A 拿不出「签给自己的令牌」（issueToken 也拒 to=A），
  // 所以授权层必须放行 A，否则主控根本借不动任何人。
  const v = authorizeDelegate({ from: 'A', to: 'C', token: null, needTokens: 200, now: NOW });
  assert.equal(v.ok, true);
  // 身份表那一道仍然管得住 A：不能借调自己
  assert.equal(authorizeDelegate({ from: 'A', to: 'A', token: null, needTokens: 1, now: NOW }).ok, false);
});
