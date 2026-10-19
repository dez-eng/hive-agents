/**
 * `hive init` 的零 API 测试。
 *
 * 重点是「不覆盖」：init 是帮忙，不是重置。已有配置必须原样留着，
 * 只有 --force 才动。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initFiles } from '../src/core/init.js';

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hive-init-'));
  try {
    return fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 偶尔删不掉 */
    }
  }
}

test('init：生成三个模板，内容可直接用', () => {
  withDir((dir) => {
    const r = initFiles(dir);
    assert.deepEqual(r.written.sort(), ['.env.example', '.hive/policy.json', 'hive.config.example.json']);
    assert.equal(r.skipped.length, 0);

    const env = readFileSync(join(dir, '.env.example'), 'utf8');
    assert.match(env, /DEEPSEEK_API_KEY=/);

    const policy = JSON.parse(readFileSync(join(dir, '.hive/policy.json'), 'utf8')) as {
      default: string;
      agents: Record<string, unknown>;
      mcp: { allowServers: string[] };
    };
    assert.equal(policy.default, 'deny', '模板必须与内置默认一致：默认拒绝');
    assert.ok(policy.agents['A']);
    assert.deepEqual(policy.mcp.allowServers, []);

    const cfg = JSON.parse(readFileSync(join(dir, 'hive.config.example.json'), 'utf8')) as {
      mcp: { agents: string[] };
    };
    assert.deepEqual(cfg.mcp.agents, ['A']);
  });
});

test('init：已有文件不覆盖；--force 才覆盖', () => {
  withDir((dir) => {
    initFiles(dir);
    writeFileSync(join(dir, '.env.example'), 'MY=CUSTOM\n', 'utf8');

    const again = initFiles(dir);
    assert.deepEqual(again.written, []);
    assert.equal(again.skipped.length, 3);
    assert.equal(readFileSync(join(dir, '.env.example'), 'utf8'), 'MY=CUSTOM\n', '用户的文件必须原样留着');

    const forced = initFiles(dir, { force: true });
    assert.equal(forced.written.length, 3);
    assert.match(readFileSync(join(dir, '.env.example'), 'utf8'), /DEEPSEEK_API_KEY=/);
  });
});
