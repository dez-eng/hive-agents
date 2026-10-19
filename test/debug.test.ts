/**
 * v4 M4.3：调试日志与 SQLite busy_timeout。零 API。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { debug, debugEnabled } from '../src/core/debug.js';
import { Ledger } from '../src/core/ledger.js';

test('debugEnabled：只认显式开启', () => {
  assert.equal(debugEnabled({ HIVE_DEBUG: '1' } as NodeJS.ProcessEnv), true);
  assert.equal(debugEnabled({ HIVE_DEBUG: 'true' } as NodeJS.ProcessEnv), true);
  assert.equal(debugEnabled({ HIVE_DEBUG: 'YES' } as NodeJS.ProcessEnv), true);
  assert.equal(debugEnabled({ HIVE_DEBUG: 'on' } as NodeJS.ProcessEnv), true);
  assert.equal(debugEnabled({ HIVE_DEBUG: '0' } as NodeJS.ProcessEnv), false);
  assert.equal(debugEnabled({} as NodeJS.ProcessEnv), false);
});

test('debug：关闭时零输出；开启时格式固定', () => {
  const origEnv = process.env.HIVE_DEBUG;
  const chunks: string[] = [];
  const origWrite = process.stderr.write;
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    chunks.push(s);
    return true;
  };
  try {
    delete process.env.HIVE_DEBUG;
    debug('t', 'off');
    assert.equal(chunks.length, 0, '默认不该有任何输出');

    process.env.HIVE_DEBUG = '1';
    debug('t', 'on', { a: 1 });
    assert.equal(chunks.length, 1);
    assert.match(chunks[0]!, /\[hive .+ t\] on \{"a":1\}/);
  } finally {
    (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    if (origEnv === undefined) delete process.env.HIVE_DEBUG;
    else process.env.HIVE_DEBUG = origEnv;
  }
});

test('ledger：打开时设置 busy_timeout（多实例并发不立刻 busy）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-busy-'));
  const led = new Ledger(join(dir, 't.db'));
  assert.equal(led.open(), true);
  try {
    assert.equal(led.busyTimeout(), 5000);
  } finally {
    led.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 偶尔删不掉 */
    }
  }
});
