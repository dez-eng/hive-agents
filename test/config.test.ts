/**
 * 配置发现（v4.7）的零 API 测试。
 *
 * 起因：从 `C:\Users\xyl2` 直接运行全局 `hive` 时，只读 cwd 的 `.env`，
 * 明明 `D:\langchain\.env` 有 key，却提示没设置并在构造 agent 时抛 stack。
 * 这里锁住「包根 / 用户级 / cwd」三层回退与优先级。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PACKAGE_ROOT, envFiles, loadDotEnv } from '../src/core/config.js';

test('envFiles：包根 → 用户级 → cwd，项目级在最后（优先级最高）', () => {
  const files = envFiles('C:/work/proj');
  assert.equal(files[0], resolve(PACKAGE_ROOT, '.env'), '包根兜底');
  assert.equal(files.at(-1), resolve('C:/work/proj', '.env'), 'cwd 最后加载');
  assert.ok(
    files.some((f) => f.replace(/\\/g, '/').endsWith('/.hive/.env')),
    `要有用户级 .hive/.env：${files.join(' | ')}`,
  );
});

test('loadDotEnv：高优先级先加载；shell 里的值最优先', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-env-'));
  const a = join(dir, 'a.env');
  const b = join(dir, 'b.env');
  writeFileSync(a, 'HIVE_TEST_ONLY=from-a\nHIVE_TEST_KEEP=from-a\n');
  writeFileSync(b, 'HIVE_TEST_ONLY=from-b\n');

  const saved = { ...process.env };
  try {
    process.env['HIVE_TEST_KEEP'] = 'from-shell';
    delete process.env['HIVE_TEST_ONLY'];

    loadDotEnv([a, b]);

    assert.equal(process.env['HIVE_TEST_ONLY'], 'from-b', '后加载的文件优先');
    assert.equal(process.env['HIVE_TEST_KEEP'], 'from-shell', 'shell 变量不能被文件覆盖');
  } finally {
    delete process.env['HIVE_TEST_ONLY'];
    delete process.env['HIVE_TEST_KEEP'];
    Object.assign(process.env, saved);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
});
