/**
 * `edit_file` 测试（v3 M2.5）。零 API —— 全在临时目录里跑。
 *
 * 要证明的核心只有一条：**唯一匹配才动手**。0 次、多次都必须拒绝并说清行号，
 * 绝不能猜；越界与超大文件也要挡住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TOOL_MAP } from '../src/core/capability.js';
import { normalize, setPolicySpec } from '../src/core/policy.js';

const edit = TOOL_MAP['edit_file']!;

function withDir<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'hive-edit-'));
  // roots 指向临时目录：越界用例才有意义
  setPolicySpec(normalize({ roots: [dir] }));
  return (async () => {
    try {
      for (const [name, body] of Object.entries(files)) {
        writeFileSync(join(dir, name), body, 'utf8');
      }
      return await fn(dir);
    } finally {
      setPolicySpec(null);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows 下偶尔删不掉 */
      }
    }
  })();
}

test('唯一匹配才动手：替换后内容与行号都对', async () => {
  await withDir({ 'a.ts': 'const a = 1;\nconst b = 2;\n' }, async (dir) => {
    const out = String(
      await edit.invoke({
        path: join(dir, 'a.ts'),
        old_string: 'const b = 2;',
        new_string: 'const b = 42;',
      }),
    );
    assert.ok(out.startsWith('OK'), out);
    assert.ok(out.includes('a.ts:2'), out);
    assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'const a = 1;\nconst b = 42;\n');
  });
});

test('0 次：拒绝，且一个字节都不动', async () => {
  await withDir({ 'a.ts': 'hello\n' }, async (dir) => {
    const before = readFileSync(join(dir, 'a.ts'), 'utf8');
    const out = String(
      await edit.invoke({ path: join(dir, 'a.ts'), old_string: '不存在的内容', new_string: 'x' }),
    );
    assert.ok(out.startsWith('ERROR'), out);
    assert.ok(out.includes('没找到'), out);
    assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), before);
  });
});

test('多次：拒绝并报出每一处的行号；给了 replace_all 才全换', async () => {
  await withDir({ 'a.ts': 'x\nsame\nx\nsame\n' }, async (dir) => {
    const bad = String(
      await edit.invoke({ path: join(dir, 'a.ts'), old_string: 'same', new_string: 'S' }),
    );
    assert.ok(bad.startsWith('ERROR'), bad);
    assert.ok(bad.includes('出现 2 次'), bad);
    assert.ok(bad.includes('行 2、4'), bad);
    assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'x\nsame\nx\nsame\n', '拒绝时不该写');

    const ok = String(
      await edit.invoke({
        path: join(dir, 'a.ts'),
        old_string: 'same',
        new_string: 'S',
        replace_all: true,
      }),
    );
    assert.ok(ok.startsWith('OK'), ok);
    assert.ok(ok.includes('共 2 处'), ok);
    assert.equal(readFileSync(join(dir, 'a.ts'), 'utf8'), 'x\nS\nx\nS\n');
  });
});

test('old_string 与 new_string 相同 → 拒绝（没什么可改）', async () => {
  await withDir({ 'a.ts': 'same\n' }, async (dir) => {
    const out = String(
      await edit.invoke({ path: join(dir, 'a.ts'), old_string: 'same', new_string: 'same' }),
    );
    assert.ok(out.startsWith('ERROR'), out);
  });
});

test('空 old_string → 拒绝', async () => {
  await withDir({ 'a.ts': 'same\n' }, async (dir) => {
    const out = String(await edit.invoke({ path: join(dir, 'a.ts'), old_string: '', new_string: 'x' }));
    assert.ok(out.startsWith('ERROR'), out);
  });
});

test('大于 256KB → 拒绝并指向 write_file', async () => {
  await withDir({ 'big.ts': 'a'.repeat(300 * 1024) }, async (dir) => {
    const out = String(
      await edit.invoke({ path: join(dir, 'big.ts'), old_string: 'a', new_string: 'b' }),
    );
    assert.ok(out.startsWith('ERROR'), out);
    assert.ok(out.includes('write_file'), out);
  });
});

test('越界：roots 之外的文件一律拒绝', async () => {
  await withDir({ 'a.ts': 'x\n' }, async (dir) => {
    const out = String(
      await edit.invoke({ path: join(dir, '..', 'outside.ts'), old_string: 'x', new_string: 'y' }),
    );
    assert.ok(out.startsWith('ERROR'), out);
    assert.ok(out.includes('越界'), out);
  });
});
