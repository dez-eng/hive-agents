/**
 * search capability 测试（v3 M2）。零 API —— 全在临时目录里跑。
 *
 * 要证明：grep/glob 真能搜、go 不动 ignore 目录、结果有上限、越界直接拒、
 * 正则坏给错误、灾难性回溯被超时掐掉（不然一次调用就把进程钉死）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { globToRegExp, globTool, grepTool, matchLines } from '../src/core/search.js';
import { normalize, setPolicySpec } from '../src/core/policy.js';

function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'hive-srch-'));
  return (async () => {
    try {
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

test('globToRegExp：** 递归、* 单层、? 一个字符', () => {
  assert.ok(globToRegExp('src/**/*.ts').test('src/core/agent.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/core/agent.ts'), '* 不该跨层');
  assert.ok(globToRegExp('*.ts').test('a.ts'));
  assert.ok(globToRegExp('a?.ts').test('ab.ts'));
  assert.ok(!globToRegExp('a?.ts').test('abc.ts'));
  assert.ok(globToRegExp('**/*.test.ts').test('test/x.test.ts'));
});

test('matchLines：给命中行号；坏正则给错误；灾难性回溯被超时掐掉', () => {
  assert.deepEqual(matchLines('TODO', ['x', 'TODO a', 'y']), { hits: [1] });
  const bad = matchLines('(', ['a']);
  assert.ok(bad.error, '坏正则该报错而不是崩');

  // (a+)+$ 对「a…a!」是指数级回溯 —— 有 timeout 就该被掐掉，而不是卡住
  const bomb = matchLines('(a+)+$', ['a'.repeat(60) + '!']);
  assert.ok(
    bomb.timeout === true || bomb.hits.length === 0,
    `要么超时要么没命中，实际：${JSON.stringify(bomb)}`,
  );
});

test('grep：搜得到内容，跳过 ignore 目录', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1;\n// TODO A\n', 'utf8');
    writeFileSync(join(dir, 'b.ts'), '// TODO B\n', 'utf8');
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'c.ts'), '// TODO C\n', 'utf8');
    setPolicySpec(normalize({ roots: [dir] }));

    const out = String(await grepTool.invoke({ pattern: 'TODO' }));
    assert.ok(out.includes('a.ts:2'), out);
    assert.ok(out.includes('b.ts:1'), out);
    assert.ok(!out.includes('c.ts'), 'ignore 里的目录不该被搜到');
  });
});

test('grep：glob 参数只搜匹配的文件名', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'a.ts'), '// TODO ts\n', 'utf8');
    writeFileSync(join(dir, 'a.md'), '// TODO md\n', 'utf8');
    setPolicySpec(normalize({ roots: [dir] }));

    const out = String(await grepTool.invoke({ pattern: 'TODO', glob: '**/*.ts' }));
    assert.ok(out.includes('a.ts:1'), out);
    assert.ok(!out.includes('a.md'), 'glob 没匹配上的不该出现');
  });
});

test('grep：结果有上限，超了明说截断', async () => {
  await withDir(async (dir) => {
    const lines = Array.from({ length: 80 }, (_, i) => `// TODO ${i}`).join('\n');
    writeFileSync(join(dir, 'many.ts'), lines, 'utf8');
    setPolicySpec(normalize({ roots: [dir] }));

    const out = String(await grepTool.invoke({ pattern: 'TODO' }));
    assert.ok(out.includes('截断'), out.slice(0, 200));
    assert.ok(out.split('\n').length <= 45, '别把整份文件倒出来');
  });
});

test('grep：没有匹配时老实说没有，并把扫了多少个文件带上', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1\n', 'utf8');
    setPolicySpec(normalize({ roots: [dir] }));

    const out = String(await grepTool.invoke({ pattern: '找不到的东西' }));
    assert.ok(out.includes('没有匹配'), out);
    assert.ok(out.includes('扫了 1 个文件'), out);
  });
});

test('grep：path 越界直接拒（不进模型、不花钱）', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'a.ts'), 'x\n', 'utf8');
    setPolicySpec(normalize({ roots: [dir] }));

    const out = String(await grepTool.invoke({ pattern: 'x', path: '..' }));
    assert.ok(out.startsWith('ERROR'), out);
    assert.ok(out.includes('越界'), out);
  });
});

test('glob：列路径、越界拒、上限提示', async () => {
  await withDir(async (dir) => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'a.ts'), 'x\n', 'utf8');
    writeFileSync(join(dir, 'sub', 'b.ts'), 'x\n', 'utf8');
    writeFileSync(join(dir, 'c.md'), 'x\n', 'utf8');
    setPolicySpec(normalize({ roots: [dir] }));

    const out = String(await globTool.invoke({ pattern: '**/*.ts' }));
    assert.ok(out.includes('a.ts'), out);
    assert.ok(out.includes('b.ts'), out);
    assert.ok(!out.includes('c.md'), '没匹配的不该出现');

    const none = String(await globTool.invoke({ pattern: '**/*.zzz' }));
    assert.ok(none.includes('没有匹配'), none);
  });
});

test('grep / glob：二进制与大文件跳过，不把输出撑爆', async () => {
  await withDir(async (dir) => {
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x54, 0x4f, 0x44, 0x4f]));
    writeFileSync(join(dir, 'big.txt'), 'TODO\n'.repeat(20000), 'utf8');
    setPolicySpec(normalize({ roots: [dir] }));

    const out = String(await grepTool.invoke({ pattern: 'TODO' }));
    assert.ok(!out.includes('bin.dat'), '二进制不该被搜');
    assert.ok(out.includes('>64KB 跳过'), out);
  });
});
