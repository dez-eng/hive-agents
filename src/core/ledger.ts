/**
 * 账本。用 Node 内置的 node:sqlite（零外部依赖），表结构与阶段 6.7 的
 * costs.db 对齐 —— 除了新增几列，其余列名一字不改，所以本工具
 * 能直接读你 Python 版留下的历史账。
 *
 * 加载 node:sqlite 之前要先调 silenceSqliteWarning()，所以这里用
 * createRequire 延迟加载，而不是顶部 import。
 *
 * v2 扩了四列（agent / task_id / budget_tok / budget_hit）外加两张表：
 *   tokens   —— 授权令牌（谁能借调谁、有多少预算、什么时候过期）
 *   handoffs —— 交接记录（谁把什么交给了谁、花了多少）
 * 老库靠 ALTER TABLE 补列，旧行照读，sqlite 的 ADD COLUMN 是 O(1)。
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { BLOCK, ledgerPath, modelName } from './config.js';
import { debug } from './debug.js';
import type { Token } from './grant.js';

const requireNative = createRequire(import.meta.url);

interface StmtLike {
  run(...params: unknown[]): { changes?: number; lastInsertRowid?: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface DbLike {
  exec(sql: string): void;
  prepare(sql: string): StmtLike;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => DbLike;
}

export interface LedgerEntry {
  kind: string;
  threadId: string;
  module: string;
  calls: number;
  inTok: number;
  cacheHit: number;
  outTok: number;
  reasoning: number;
  costUsd: number;
  userChars?: number;
  userHead?: string;
  outHead?: string;
  styleOn?: number;
  model?: string;
  band?: string;
  runId?: string;
  /** v2：这一轮是谁在干（A 主 / B 侦察 / C 修复 / D 审计） */
  agent?: string;
  /** v2：子任务 id —— 借调产生的那几轮带它，便于对账 */
  taskId?: string;
  /** v2：子任务的预算闸门（token） */
  budgetTok?: number;
  /** v2：这一轮是否被预算闸门熔断（1 = 是） */
  budgetHit?: number;
  /** v3 M2：policy 行的动作目标（文件路径 / 子任务目标身份） */
  target?: string;
  /** v3 M2：policy 行的判定 —— allow / deny / ask-pending */
  verdict?: string;
  /** v3 M2：policy 行命中的规则，或拒绝原因 */
  reason?: string;
}

export interface LedgerRow {
  id: number;
  ts: string;
  day: string;
  runId: string;
  threadId: string;
  model: string;
  band: string;
  kind: string;
  module: string;
  calls: number;
  inTok: number;
  cacheHit: number;
  outTok: number;
  reasoning: number;
  costUsd: number;
  userChars: number;
  userHead: string;
  outHead: string;
  styleOn: number;
  agent: string;
  taskId: string;
  budgetTok: number;
  budgetHit: number;
  target: string;
  verdict: string;
  reason: string;
}

export interface LedgerTotals {
  calls: number;
  inTok: number;
  cacheHit: number;
  outTok: number;
  reasoning: number;
  costUsd: number;
  rows: number;
}

/** v3 M3：按身份汇总 —— 「每个 agent 自己跑时命中率与成本如何」 */
export interface AgentTotals extends LedgerTotals {
  /** '' = M3 之前没标身份的老行（展示层写成「未标记」，不丢弃） */
  agent: string;
}

/** 一次交接的记录 —— 交接走 schema，落库也只落结构化字段 */
export interface HandoffRecord {
  id?: number;
  ts?: string;
  taskId: string;
  from: string;
  to: string;
  goal: string;
  expect: string;
  budgetTok: number;
  tokens: number;
  costUsd: number;
  ok: boolean;
  budgetHit: boolean;
  notes?: string;
  output?: string;
  /**
   * v3 M3：子会话 thread —— 续跑靠它回到同一个 checkpoint。
   * M3 之前的老记录没有这一列（空串），明确报「无法续跑」，不猜。
   */
  thread?: string;
}

/** 整段压成一行，取前 n 字 —— 用来在账本里认出「这轮问了什么、答了什么」 */
export function head(s: unknown, n = 50): string {
  try {
    return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  } catch {
    return '';
  }
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

function bool(v: unknown): boolean {
  return num(v) !== 0;
}

function mapRow(r: Record<string, unknown>): LedgerRow {
  return {
    id: num(r['id']),
    ts: str(r['ts']),
    day: str(r['day']),
    runId: str(r['run_id']),
    threadId: str(r['thread_id']),
    model: str(r['model']),
    band: str(r['band']),
    kind: str(r['tag']),
    module: str(r['module']),
    calls: num(r['calls']),
    inTok: num(r['in_tok']),
    cacheHit: num(r['cache_hit']),
    outTok: num(r['out_tok']),
    reasoning: num(r['reason_tok']),
    costUsd: num(r['cost_usd']),
    userChars: num(r['user_chars']),
    userHead: str(r['user_head']),
    outHead: str(r['out_head']),
    styleOn: Number.isFinite(Number(r['style_on'])) ? Number(r['style_on']) : -1,
    agent: str(r['agent']),
    taskId: str(r['task_id']),
    budgetTok: num(r['budget_tok']),
    budgetHit: num(r['budget_hit']),
    target: str(r['target']),
    verdict: str(r['verdict']),
    reason: str(r['reason']),
  };
}

const COLUMNS =
  'id, ts, day, run_id, thread_id, model, band, tag, module, calls, in_tok, cache_hit,' +
  ' out_tok, reason_tok, cost_usd, user_chars, user_head, out_head, style_on,' +
  ' agent, task_id, budget_tok, budget_hit, target, verdict, reason';

/** 未命中 = 入 − 命中；余额 = 未命中 − (入 mod 64)；k = 余额 ÷ 64 */
export function kBlocksOf(inTok: number, cacheHit: number): number {
  const miss = Math.max(inTok - cacheHit, 0);
  if (!miss) return 0;
  return (miss - (inTok % BLOCK)) / BLOCK;
}

export function missOf(inTok: number, cacheHit: number): number {
  return Math.max(inTok - cacheHit, 0);
}

/** v3 M3：handoffs 行 → 结构化记录（含续跑要用的 thread） */
function mapHandoff(r: Record<string, unknown>): HandoffRecord {
  return {
    id: num(r['id']),
    ts: str(r['ts']),
    taskId: str(r['task_id']),
    from: str(r['from_agent']),
    to: str(r['to_agent']),
    goal: str(r['goal']),
    expect: str(r['expect']),
    budgetTok: num(r['budget_tok']),
    tokens: num(r['tokens']),
    costUsd: num(r['cost_usd']),
    ok: bool(r['ok']),
    budgetHit: bool(r['budget_hit']),
    notes: str(r['notes']),
    output: str(r['output_head']),
    thread: str(r['thread']),
  };
}

function tokenFromRow(r: Record<string, unknown>): Token {
  let mayCall: Token['mayCall'] = [];
  try {
    const parsed: unknown = JSON.parse(str(r['may_call']) || '[]');
    if (Array.isArray(parsed)) mayCall = parsed as Token['mayCall'];
  } catch {
    /* 坏了就当空 —— 空 mayCall 等于什么都借不动，安全侧 */
  }
  const t: Token = {
    id: str(r['id']),
    issuedBy: str(r['issued_by']) as Token['issuedBy'],
    to: str(r['to_agent']) as Token['to'],
    mayCall,
    budgetTokens: num(r['budget_tok']),
    issuedAt: num(r['issued_at']),
    expiresAt: num(r['expires_at']),
    spent: num(r['spent']),
  };
  const note = str(r['note']);
  return note ? { ...t, note } : t;
}

export class Ledger {
  readonly path: string;
  readonly runId: string;
  private db: DbLike | null = null;

  constructor(path = ledgerPath(), runId = randomUUID().slice(0, 8)) {
    this.path = resolve(path);
    this.runId = runId;
  }

  get open_(): boolean {
    return this.db !== null;
  }

  /** 打不开就静默降级 —— 记账绝不该弄挂对话 */
  open(): boolean {
    if (this.db) return true;
    try {
      const target = resolve(this.path);
      mkdirSync(dirname(target), { recursive: true });
      const sqlite = requireNative('node:sqlite') as SqliteModule;
      const db = new sqlite.DatabaseSync(target);
      // v4 M4.3：多实例并发时，写冲突最多等 5 秒再报 busy（而不是立刻抛）
      db.exec('PRAGMA busy_timeout = 5000');
      debug('ledger', 'open', { path: target });
      db.exec(`
        CREATE TABLE IF NOT EXISTS ledger (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          ts         TEXT    NOT NULL,
          day        TEXT    NOT NULL,
          run_id     TEXT    NOT NULL,
          thread_id  TEXT    NOT NULL,
          model      TEXT    NOT NULL,
          band       TEXT    NOT NULL,
          tag        TEXT    NOT NULL,
          calls      INTEGER NOT NULL,
          in_tok     INTEGER NOT NULL,
          cache_hit  INTEGER NOT NULL,
          out_tok    INTEGER NOT NULL,
          reason_tok INTEGER NOT NULL DEFAULT 0,
          user_chars INTEGER NOT NULL DEFAULT 0,
          user_head  TEXT    NOT NULL DEFAULT '',
          out_head   TEXT    NOT NULL DEFAULT '',
          cost_usd   REAL    NOT NULL,
          style_on   INTEGER NOT NULL DEFAULT -1,
          agent      TEXT    NOT NULL DEFAULT '',
          task_id    TEXT    NOT NULL DEFAULT '',
          budget_tok INTEGER NOT NULL DEFAULT 0,
          budget_hit INTEGER NOT NULL DEFAULT 0,
          target     TEXT    NOT NULL DEFAULT '',
          verdict    TEXT    NOT NULL DEFAULT '',
          reason     TEXT    NOT NULL DEFAULT ''
        )
      `);

      // 老库（6.5~6.7 写的，以及 v0.1 的 hive）补列
      const cols = new Set(
        db.prepare('PRAGMA table_info(ledger)').all().map((r) => str(r['name'])),
      );
      const patches: Array<[string, string]> = [
        ['reason_tok', 'ALTER TABLE ledger ADD COLUMN reason_tok INTEGER NOT NULL DEFAULT 0'],
        ['user_chars', 'ALTER TABLE ledger ADD COLUMN user_chars INTEGER NOT NULL DEFAULT 0'],
        ['user_head', "ALTER TABLE ledger ADD COLUMN user_head TEXT NOT NULL DEFAULT ''"],
        ['out_head', "ALTER TABLE ledger ADD COLUMN out_head TEXT NOT NULL DEFAULT ''"],
        ['style_on', 'ALTER TABLE ledger ADD COLUMN style_on INTEGER NOT NULL DEFAULT -1'],
        ['module', "ALTER TABLE ledger ADD COLUMN module TEXT NOT NULL DEFAULT ''"],
        ['agent', "ALTER TABLE ledger ADD COLUMN agent TEXT NOT NULL DEFAULT ''"],
        ['task_id', "ALTER TABLE ledger ADD COLUMN task_id TEXT NOT NULL DEFAULT ''"],
        ['budget_tok', 'ALTER TABLE ledger ADD COLUMN budget_tok INTEGER NOT NULL DEFAULT 0'],
        ['budget_hit', 'ALTER TABLE ledger ADD COLUMN budget_hit INTEGER NOT NULL DEFAULT 0'],
        // v3 M2：能力网关的判罚留痕（sqlite 的 ADD COLUMN 是 O(1)，旧行照读）
        ['target', "ALTER TABLE ledger ADD COLUMN target TEXT NOT NULL DEFAULT ''"],
        ['verdict', "ALTER TABLE ledger ADD COLUMN verdict TEXT NOT NULL DEFAULT ''"],
        ['reason', "ALTER TABLE ledger ADD COLUMN reason TEXT NOT NULL DEFAULT ''"],
      ];
      for (const [col, ddl] of patches) {
        if (!cols.has(col)) db.exec(ddl);
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_day ON ledger(day)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_run ON ledger(run_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_tag ON ledger(tag)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_thread ON ledger(thread_id)');

      // v2：授权令牌
      db.exec(`
        CREATE TABLE IF NOT EXISTS tokens (
          id         TEXT    PRIMARY KEY,
          issued_by  TEXT    NOT NULL,
          to_agent   TEXT    NOT NULL,
          may_call   TEXT    NOT NULL DEFAULT '[]',
          budget_tok INTEGER NOT NULL DEFAULT 0,
          issued_at  INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          spent      INTEGER NOT NULL DEFAULT 0,
          note       TEXT    NOT NULL DEFAULT ''
        )
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_tok_to ON tokens(to_agent)');

      // v2：交接记录（谁把什么交给了谁、花了多少）
      db.exec(`
        CREATE TABLE IF NOT EXISTS handoffs (
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
          output_head TEXT    NOT NULL DEFAULT '',
          thread      TEXT    NOT NULL DEFAULT ''
        )
      `);
      // v3 M3：老库补 thread 列（已经建好的 handoffs 表没有它）
      const hcols = new Set(
        db.prepare('PRAGMA table_info(handoffs)').all().map((r) => str(r['name'])),
      );
      if (!hcols.has('thread')) {
        db.exec("ALTER TABLE handoffs ADD COLUMN thread TEXT NOT NULL DEFAULT ''");
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_ho_task ON handoffs(task_id)');

      this.db = db;
      return true;
    } catch {
      this.db = null;
      return false;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* 关不上就算了 */
    }
    this.db = null;
  }

  insert(e: LedgerEntry): number | null {
    if (!this.db) return null;
    try {
      const at = new Date();
      const stmt = this.db.prepare(
        'INSERT INTO ledger (ts, day, run_id, thread_id, model, band, tag, module,' +
          ' calls, in_tok, cache_hit, out_tok, reason_tok, user_chars, user_head,' +
          ' out_head, cost_usd, style_on, agent, task_id, budget_tok, budget_hit,' +
          ' target, verdict, reason)' +
          ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      );
      const res = stmt.run(
        at.toISOString().slice(0, 19),
        at.toISOString().slice(0, 10),
        e.runId ?? this.runId,
        e.threadId,
        e.model ?? modelName(),
        e.band ?? '',
        e.kind,
        e.module,
        e.calls,
        e.inTok,
        e.cacheHit,
        e.outTok,
        e.reasoning,
        e.userChars ?? 0,
        head(e.userHead),
        head(e.outHead),
        e.costUsd,
        e.styleOn ?? -1,
        e.agent ?? '',
        e.taskId ?? '',
        e.budgetTok ?? 0,
        e.budgetHit ?? 0,
        e.target ?? '',
        e.verdict ?? '',
        e.reason ?? '',
      );
      const id = res.lastInsertRowid;
      return typeof id === 'number' ? id : null;
    } catch {
      return null;
    }
  }

  /**
   * v3 M2：能力网关的一次判定（放行与拒绝都记 —— V3-PLAN §4.2 第 4 条）。
   * 它不花钱，也不参与任何 token 统计（查询都按 tag='turn' 过滤），
   * 但它解释「钱能花在哪儿」——被拒的动作没进模型，等于没花钱。
   */
  insertPolicy(p: {
    capability: string;
    agent: string;
    target: string;
    verdict: string;
    reason: string;
    threadId?: string;
    taskId?: string;
  }): number | null {
    return this.insert({
      kind: 'policy',
      threadId: p.threadId ?? '',
      module: p.capability,
      agent: p.agent,
      calls: 0,
      inTok: 0,
      cacheHit: 0,
      outTok: 0,
      reasoning: 0,
      costUsd: 0,
      userHead: `${p.verdict} ${p.capability} ${p.target}`,
      target: p.target,
      verdict: p.verdict,
      reason: p.reason,
      ...(p.taskId ? { taskId: p.taskId } : {}),
    });
  }

  /** 最近的判罚行（/policy log 用） */
  recentPolicy(limit = 20): LedgerRow[] {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(`SELECT ${COLUMNS} FROM ledger WHERE tag='policy' ORDER BY id DESC LIMIT ?`)
        .all(limit)
        .map(mapRow);
    } catch {
      return [];
    }
  }

  recent(limit = 12): LedgerRow[] {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(`SELECT ${COLUMNS} FROM ledger ORDER BY id DESC LIMIT ?`)
        .all(limit)
        .map(mapRow);
    } catch {
      return [];
    }
  }

  /** 某一会话的逐轮（升序），用于 /turn 编号 */
  turnsOf(threadId: string): LedgerRow[] {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          `SELECT ${COLUMNS} FROM ledger WHERE tag='turn' AND thread_id=? ORDER BY id ASC`,
        )
        .all(threadId)
        .map(mapRow);
    } catch {
      return [];
    }
  }

  /** 本次运行的逐轮 */
  turnsOfRun(runId = this.runId): LedgerRow[] {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(`SELECT ${COLUMNS} FROM ledger WHERE tag='turn' AND run_id=? ORDER BY id ASC`)
        .all(runId)
        .map(mapRow);
    } catch {
      return [];
    }
  }

  /** 全部轮次（升序）。/misscheck 要按时间顺序配对，所以不能倒序取 */
  allTurns(limit = 2000): LedgerRow[] {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(`SELECT ${COLUMNS} FROM ledger WHERE tag='turn' ORDER BY id ASC LIMIT ?`)
        .all(limit)
        .map(mapRow);
    } catch {
      return [];
    }
  }

  /** 跨历史模糊找轮次 —— 「哪一轮花了钱」的快速入口 */
  search(text: string, limit = 20): LedgerRow[] {
    if (!this.db) return [];
    try {
      const like = `%${text}%`;
      return this.db
        .prepare(
          `SELECT ${COLUMNS} FROM ledger WHERE tag='turn' AND (user_head LIKE ? OR out_head LIKE ?)` +
            ' ORDER BY id DESC LIMIT ?',
        )
        .all(like, like, limit)
        .map(mapRow);
    } catch {
      return [];
    }
  }

  /** 某个子任务（借调）的逐轮 */
  turnsOfTask(taskId: string): LedgerRow[] {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(`SELECT ${COLUMNS} FROM ledger WHERE task_id=? ORDER BY id ASC`)
        .all(taskId)
        .map(mapRow);
    } catch {
      return [];
    }
  }

  totals(scope: { day?: string; runId?: string; threadId?: string } = {}): LedgerTotals | null {
    if (!this.db) return null;
    try {
      const where: string[] = [
        // v3 M2：能力网关的判罚行不是消费 —— 它不能进任何账单统计
        "tag <> 'policy'",
      ];
      const args: unknown[] = [];
      if (scope.day) {
        where.push('day = ?');
        args.push(scope.day);
      }
      if (scope.runId) {
        where.push('run_id = ?');
        args.push(scope.runId);
      }
      if (scope.threadId) {
        where.push('thread_id = ?');
        args.push(scope.threadId);
      }
      const sql =
        'SELECT COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(in_tok),0) AS in_tok,' +
        ' COALESCE(SUM(cache_hit),0) AS cache_hit, COALESCE(SUM(out_tok),0) AS out_tok,' +
        ' COALESCE(SUM(reason_tok),0) AS reason_tok, COALESCE(SUM(cost_usd),0) AS cost_usd,' +
        ' COUNT(*) AS rows FROM ledger' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '');
      const r = this.db.prepare(sql).get(...args);
      if (!r) return null;
      return {
        calls: num(r['calls']),
        inTok: num(r['in_tok']),
        cacheHit: num(r['cache_hit']),
        outTok: num(r['out_tok']),
        reasoning: num(r['reason_tok']),
        costUsd: num(r['cost_usd']),
        rows: num(r['rows']),
      };
    } catch {
      return null;
    }
  }

  /**
   * v3 M3：按 agent 汇总。只统计 tag='turn' —— policy 行不是消费。
   * agent='' 的老行原样保留（展示层标「未标记」），不丢历史账。
   */
  byAgent(scope: { day?: string; runId?: string; threadId?: string } = {}): AgentTotals[] {
    if (!this.db) return [];
    try {
      const where: string[] = ["tag = 'turn'"];
      const args: unknown[] = [];
      if (scope.day) {
        where.push('day = ?');
        args.push(scope.day);
      }
      if (scope.runId) {
        where.push('run_id = ?');
        args.push(scope.runId);
      }
      if (scope.threadId) {
        where.push('thread_id = ?');
        args.push(scope.threadId);
      }
      const sql =
        'SELECT agent, COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(in_tok),0) AS in_tok,' +
        ' COALESCE(SUM(cache_hit),0) AS cache_hit, COALESCE(SUM(out_tok),0) AS out_tok,' +
        ' COALESCE(SUM(reason_tok),0) AS reason_tok, COALESCE(SUM(cost_usd),0) AS cost_usd,' +
        ' COUNT(*) AS rows FROM ledger WHERE ' +
        where.join(' AND ') +
        ' GROUP BY agent ORDER BY agent';
      return this.db
        .prepare(sql)
        .all(...args)
        .map((r) => ({
          agent: str(r['agent']),
          calls: num(r['calls']),
          inTok: num(r['in_tok']),
          cacheHit: num(r['cache_hit']),
          outTok: num(r['out_tok']),
          reasoning: num(r['reason_tok']),
          costUsd: num(r['cost_usd']),
          rows: num(r['rows']),
        }));
    } catch {
      return [];
    }
  }

  days(limit = 7): Array<{ day: string } & LedgerTotals> {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          'SELECT day, COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(in_tok),0) AS in_tok,' +
            ' COALESCE(SUM(cache_hit),0) AS cache_hit, COALESCE(SUM(out_tok),0) AS out_tok,' +
            ' COALESCE(SUM(reason_tok),0) AS reason_tok, COALESCE(SUM(cost_usd),0) AS cost_usd,' +
            " COUNT(*) AS rows FROM ledger WHERE tag <> 'policy' GROUP BY day ORDER BY day DESC LIMIT ?",
        )
        .all(limit)
        .map((r) => ({
          day: str(r['day']),
          calls: num(r['calls']),
          inTok: num(r['in_tok']),
          cacheHit: num(r['cache_hit']),
          outTok: num(r['out_tok']),
          reasoning: num(r['reason_tok']),
          costUsd: num(r['cost_usd']),
          rows: num(r['rows']),
        }));
    } catch {
      return [];
    }
  }

  since(): string | null {
    if (!this.db) return null;
    try {
      const r = this.db.prepare('SELECT MIN(ts) AS ts FROM ledger').get();
      const v = str(r?.['ts']);
      return v || null;
    } catch {
      return null;
    }
  }

  /** v4 M4.3：诊断用 —— 当前 busy_timeout（毫秒）；0 = 没打开或设不上 */
  busyTimeout(): number {
    if (!this.db) return 0;
    try {
      const r = this.db.prepare('PRAGMA busy_timeout').get();
      return Number(r?.['timeout'] ?? 0);
    } catch {
      return 0;
    }
  }

  // ── v2：令牌 ─────────────────────────────────────────────

  saveToken(t: Token): boolean {
    if (!this.db) return false;
    try {
      this.db
        .prepare(
          'INSERT OR REPLACE INTO tokens (id, issued_by, to_agent, may_call, budget_tok,' +
            ' issued_at, expires_at, spent, note) VALUES (?,?,?,?,?,?,?,?,?)',
        )
        .run(
          t.id,
          t.issuedBy,
          t.to,
          JSON.stringify(t.mayCall),
          t.budgetTokens,
          t.issuedAt,
          t.expiresAt,
          t.spent,
          t.note ?? '',
        );
      return true;
    } catch {
      return false;
    }
  }

  loadToken(id: string): Token | null {
    if (!this.db) return null;
    try {
      const r = this.db.prepare('SELECT * FROM tokens WHERE id=?').get(id);
      return r ? tokenFromRow(r) : null;
    } catch {
      return null;
    }
  }

  /** 手上还有效的令牌（未过期，可选按持有人过滤）—— 按签发时间新的在前 */
  liveTokens(to?: string, now = Date.now()): Token[] {
    if (!this.db) return [];
    try {
      const rows = to
        ? this.db
            .prepare('SELECT * FROM tokens WHERE to_agent=? AND expires_at>=? ORDER BY issued_at DESC')
            .all(to, now)
        : this.db
            .prepare('SELECT * FROM tokens WHERE expires_at>=? ORDER BY issued_at DESC')
            .all(now);
      return rows.map(tokenFromRow);
    } catch {
      return [];
    }
  }

  /** 记一笔消耗（按 id 覆盖 spent） */
  updateTokenSpent(id: string, spent: number): boolean {
    if (!this.db) return false;
    try {
      this.db.prepare('UPDATE tokens SET spent=? WHERE id=?').run(Math.trunc(spent), id);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * v4 M4.1：并发安全地**预留**一笔预算。
   *
   * 「检查余额 + 扣减」必须在同一条 SQL 里完成，否则两个并发子任务会同时
   * 看到同一份余额（超卖）。条件更新是原子的：changes=0 就是没抢到。
   * 账本打不开时不阻塞 —— 与其它写方法一致：落不了盘不等于不能用。
   */
  reserveToken(id: string, amount: number): boolean {
    const need = Math.trunc(amount);
    if (need <= 0) return true;
    if (!this.db) return true;
    try {
      const r = this.db
        .prepare('UPDATE tokens SET spent = spent + ? WHERE id=? AND spent + ? <= budget_tok')
        .run(need, id, need);
      if (Number(r.changes) > 0) return true;
      // 条件更新没抢到：要么余额不够，要么这张令牌只在内存里（测试 / 未落库）。
      // 后者交给 authorizeDelegate 与结算兜底 —— 不能把「没这行」误判成超预算。
      const exists = this.db.prepare('SELECT 1 FROM tokens WHERE id=?').get(id);
      return !exists;
    } catch {
      return false;
    }
  }

  /**
   * 预留 → 结算：把预留额换成实际消耗（delta 可负，即退回多留的部分）。
   * 用增量而不是覆盖，避免把并发期间别处记的账冲掉。
   */
  settleToken(id: string, reserved: number, actual: number): boolean {
    const delta = Math.trunc(actual) - Math.trunc(reserved);
    if (delta === 0) return true;
    if (!this.db) return true;
    try {
      this.db.prepare('UPDATE tokens SET spent = spent + ? WHERE id=?').run(delta, id);
      return true;
    } catch {
      return false;
    }
  }

  // ── v2：交接记录 ──────────────────────────────────────────

  insertHandoff(h: HandoffRecord): number | null {
    if (!this.db) return null;
    try {
      const at = new Date();
      const res = this.db
        .prepare(
          'INSERT INTO handoffs (task_id, ts, day, from_agent, to_agent, goal, expect,' +
            ' budget_tok, tokens, cost_usd, ok, budget_hit, notes, output_head, thread)' +
            ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          h.taskId,
          at.toISOString().slice(0, 19),
          at.toISOString().slice(0, 10),
          h.from,
          h.to,
          head(h.goal, 80),
          head(h.expect, 80),
          h.budgetTok,
          h.tokens,
          h.costUsd,
          h.ok ? 1 : 0,
          h.budgetHit ? 1 : 0,
          h.notes ?? '',
          head(h.output, 80),
          h.thread ?? '',
        );
      const id = res.lastInsertRowid;
      return typeof id === 'number' ? id : null;
    } catch {
      return null;
    }
  }

  recentHandoffs(limit = 10): HandoffRecord[] {
    if (!this.db) return [];
    try {
      return this.db
        .prepare('SELECT * FROM handoffs ORDER BY id DESC LIMIT ?')
        .all(limit)
        .map(mapHandoff);
    } catch {
      return [];
    }
  }

  /**
   * v3 M3：按 task 找最近一次交接 —— 续跑要拿 thread / from / to。
   * 同一 task 可以有多行（首跑 + 每次续跑），最近的才是当前会话。
   */
  findHandoff(taskId: string): HandoffRecord | null {
    if (!this.db) return null;
    try {
      const r = this.db
        .prepare('SELECT * FROM handoffs WHERE task_id=? ORDER BY id DESC LIMIT 1')
        .get(taskId);
      return r ? mapHandoff(r) : null;
    } catch {
      return null;
    }
  }

  /** 一次借调花了多少（按 task 汇总） */
  handoffTotals(taskId: string): { tokens: number; costUsd: number; rows: number } | null {
    if (!this.db) return null;
    try {
      const r = this.db
        .prepare(
          'SELECT COALESCE(SUM(tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost_usd,' +
            ' COUNT(*) AS rows FROM handoffs WHERE task_id=?',
        )
        .get(taskId);
      if (!r) return null;
      return { tokens: num(r['tokens']), costUsd: num(r['cost_usd']), rows: num(r['rows']) };
    } catch {
      return null;
    }
  }
}
