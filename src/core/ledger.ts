/**
 * 账本。用 Node 内置的 node:sqlite（零外部依赖），表结构与阶段 6.7 的
 * costs.db 对齐 —— 除了新增一列 module，其余列名一字不改，所以本工具
 * 能直接读你 Python 版留下的历史账。
 *
 * 加载 node:sqlite 之前要先调 silenceSqliteWarning()，所以这里用
 * createRequire 延迟加载，而不是顶部 import。
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { BLOCK, ledgerPath, modelName } from './config.js';

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
  };
}

const COLUMNS =
  'id, ts, day, run_id, thread_id, model, band, tag, module, calls, in_tok, cache_hit,' +
  ' out_tok, reason_tok, cost_usd, user_chars, user_head, out_head, style_on';

/** 未命中 = 入 − 命中；余额 = 未命中 − (入 mod 64)；k = 余额 ÷ 64 */
export function kBlocksOf(inTok: number, cacheHit: number): number {
  const miss = Math.max(inTok - cacheHit, 0);
  if (!miss) return 0;
  return (miss - (inTok % BLOCK)) / BLOCK;
}

export function missOf(inTok: number, cacheHit: number): number {
  return Math.max(inTok - cacheHit, 0);
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
          style_on   INTEGER NOT NULL DEFAULT -1
        )
      `);

      // 老库（6.5~6.7 写的）补列
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
      ];
      for (const [col, ddl] of patches) {
        if (!cols.has(col)) db.exec(ddl);
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_day ON ledger(day)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_run ON ledger(run_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_tag ON ledger(tag)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_thread ON ledger(thread_id)');

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
          ' out_head, cost_usd, style_on)' +
          ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
      );
      const id = res.lastInsertRowid;
      return typeof id === 'number' ? id : null;
    } catch {
      return null;
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

  totals(scope: { day?: string; runId?: string; threadId?: string } = {}): LedgerTotals | null {
    if (!this.db) return null;
    try {
      const where: string[] = [];
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

  days(limit = 7): Array<{ day: string } & LedgerTotals> {
    if (!this.db) return [];
    try {
      return this.db
        .prepare(
          'SELECT day, COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(in_tok),0) AS in_tok,' +
            ' COALESCE(SUM(cache_hit),0) AS cache_hit, COALESCE(SUM(out_tok),0) AS out_tok,' +
            ' COALESCE(SUM(reason_tok),0) AS reason_tok, COALESCE(SUM(cost_usd),0) AS cost_usd,' +
            ' COUNT(*) AS rows FROM ledger GROUP BY day ORDER BY day DESC LIMIT ?',
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
}
