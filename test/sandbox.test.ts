/**
 * 沙箱加固测试（v3 M2.6）。零 API。
 *
 * 两件事要证明：
 *   1. **子进程看不到敏感环境变量**（含真 `DEEPSEEK_API_KEY`），但 PATH/SystemRoot 之类还在
 *   2. **路径判定解析真实路径** —— 项目里的链接指向外面会被拒，指向内部照常放行
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TOOL_MAP } from '../src/core/capability.js';
import { bashTool, childEnv, envKeepList } from '../src/core/bash.js';
import { checkAction, normalize, setPolicySpec, withinRootsReal, type Action } from '../src/core/policy.js';

test.afterEach(() => {
  setPolicySpec(null);
});

// ── 一、env 清理 ────────────────────────────────────────────────

test('env 最小集：敏感变量一律抹掉，基础变量还在', () => {
  const fake = {
    PATH: '/usr/bin',
    SystemRoot: 'C:\\Windows',
    TEMP: '/tmp',
    DEEPSEEK_API_KEY: 'sk-should-never-pass',
    AWS_SECRET_ACCESS_KEY: 'nope',
    MY_PASSWORD: 'nope',
    GITHUB_TOKEN: 'nope',
  } as NodeJS.ProcessEnv;

  const out = childEnv(fake, []);
  assert.equal(out['PATH'], '/usr/bin');
  assert.equal(out['SystemRoot'], 'C:\\Windows');
  assert.equal(out['TEMP'], '/tmp');
  assert.equal(out['DEEPSEEK_API_KEY'], undefined);
  assert.equal(out['AWS_SECRET_ACCESS_KEY'], undefined);
  assert.equal(out['MY_PASSWORD'], undefined);
  assert.equal(out['GITHUB_TOKEN'], undefined);
});

test('逃生舱：显式列出的才透传，且仍过敏感词过滤', () => {
  const env = { GOPATH: '/go', HIVE_TEST_SAFE: 'ok', ANOTHER_KEY: 'secret' } as NodeJS.ProcessEnv;
  const out = childEnv(env, ['GOPATH', 'HIVE_TEST_SAFE', 'ANOTHER_KEY']);
  assert.equal(out['GOPATH'], '/go');
  assert.equal(out['HIVE_TEST_SAFE'], 'ok');
  assert.equal(out['ANOTHER_KEY'], undefined, '逃生舱也过不了敏感词这一层');
});

test('envKeepList：解析 HIVE_BASH_ENV_KEEP，没设就是空', () => {
  assert.deepEqual(envKeepList({ HIVE_BASH_ENV_KEEP: 'GOPATH, JAVA_HOME' } as NodeJS.ProcessEnv), [
    'GOPATH',
    'JAVA_HOME',
  ]);
  assert.deepEqual(envKeepList({} as NodeJS.ProcessEnv), []);
});

test('真跑一次：子进程里看不到任何敏感变量（含真 DEEPSEEK_API_KEY）', async () => {
  process.env['HIVE_FAKE_TOKEN_FOR_TEST'] = 'must-not-leak';
  setPolicySpec(normalize({ exec: { allowCommands: ['node'] } }));
  try {
    const out = String(
      await bashTool.invoke({
        command: 'node -e "process.stdout.write(Object.keys(process.env).join(\',\'))"',
      }),
    );
    assert.ok(!out.includes('HIVE_FAKE_TOKEN'), `假令牌漏了：${out}`);
    assert.ok(!/deepseek_api_key/i.test(out), `API key 的名字漏了：${out}`);
    assert.ok(out.includes('PATH') || out.includes('SystemRoot'), `基础变量该在：${out}`);
  } finally {
    delete process.env['HIVE_FAKE_TOKEN_FOR_TEST'];
  }
});

// ── 二、realpath 校验 ──────────────────────────────────────────

test('realpath：roots 内的普通文件、以及还没建的新文件，都放行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-sbx-plain-'));
  try {
    writeFileSync(join(dir, 'a.txt'), 'x', 'utf8');
    const spec = normalize({ roots: [dir] });
    assert.equal(withinRootsReal(join(dir, 'a.txt'), spec).ok, true);
    // 新文件还不存在：解析父目录也算得出来
    assert.equal(withinRootsReal(join(dir, 'new.txt'), spec).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 建一个目录链接。Windows 上用 junction（普通用户就能建），失败就让调用方 skip */
function tryLink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, 'junction');
    return true;
  } catch {
    try {
      symlinkSync(target, link, 'dir');
      return true;
    } catch {
      return false;
    }
  }
}

test('realpath：链接指向 roots 外面 → 拒（字符串上它明明在 roots 里）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-sbx-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'hive-sbx-out-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8');
    const link = join(root, 'link');
    if (!tryLink(outside, link)) {
      t.skip('这个平台/权限下建不了目录链接（Windows 需要开发者模式或管理员）');
      return;
    }
    const spec = normalize({ roots: [root] });
    const check = withinRootsReal(join(link, 'secret.txt'), spec);
    assert.equal(check.ok, false, `该被拒，实际解析成：${check.real}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('realpath：工具层兜底也拦得住链接穿透（read_file）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-sbx-tool-'));
  const outside = mkdtempSync(join(tmpdir(), 'hive-sbx-toolout-'));
  try {
    writeFileSync(join(outside, 'secret.txt'), 'secret', 'utf8');
    const link = join(root, 'link');
    if (!tryLink(outside, link)) {
      t.skip('建不了目录链接');
      return;
    }
    setPolicySpec(normalize({ roots: [root] }));
    const out = String(await TOOL_MAP['read_file']!.invoke({ path: join(link, 'secret.txt') }));
    assert.ok(out.startsWith('ERROR'), `该被拒：${out}`);
    assert.ok(!out.includes('secret'), '内容绝不能漏出来');
  } finally {
    setPolicySpec(null);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('realpath：链接指向 roots 内部 → 放行（monorepo 常见写法）', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'hive-sbx-in-'));
  try {
    mkdirSync(join(root, 'real'), { recursive: true });
    writeFileSync(join(root, 'real', 'a.txt'), 'x', 'utf8');
    const link = join(root, 'alias');
    if (!tryLink(join(root, 'real'), link)) {
      t.skip('建不了目录链接');
      return;
    }
    const spec = normalize({ roots: [root] });
    assert.equal(withinRootsReal(join(link, 'a.txt'), spec).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 三、两词白名单 ─────────────────────────────────────────────

test('两词白名单（工具层）："node --version" 放行，"node -e ..." 拒绝', async () => {
  setPolicySpec(normalize({ exec: { allowCommands: ['node --version'] } }));

  const ok = String(await bashTool.invoke({ command: 'node --version' }));
  assert.ok(/v\d+\./.test(ok), ok);

  const bad = String(await bashTool.invoke({ command: 'node -e "console.log(1)"' }));
  assert.ok(bad.startsWith('ERROR'), bad);
  assert.ok(bad.includes('exec.allowCommands'), bad);
});

test('两词白名单（网关层）：判定与工具层同一套语义', () => {
  const action: Action = {
    kind: 'exec',
    target: 'git push origin main',
    by: 'A',
    capability: 'shell',
    tool: 'bash',
  };
  const spec = normalize({ agents: { A: { exec: 'allow' } }, exec: { allowCommands: ['git status'] } });

  const denied = checkAction(action, spec);
  assert.equal(denied.allow, false);
  assert.equal(denied.rule, 'exec.allowCommands');

  const allowed = checkAction({ ...action, target: 'git status --short' }, spec);
  assert.equal(allowed.allow, true);
});
