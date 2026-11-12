/**
 * `bash` 测试（v3 M2.5）。零 API —— 用 `node` 当被测命令（一定存在、跨平台）。
 *
 * 要证明：白名单两层都拦得住；把命令切干净（不给 shell 才敢按 basename 判）；
 * 超时能杀掉、输出有上限、退出码如实返回。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BASH_OUTPUT_MAX,
  bashTool,
  childEnv,
  commandAllowed,
  planCommand,
  resolveExecutable,
  runCommand,
  splitCommand,
} from '../src/core/bash.js';
import { DEFAULT_SPEC, checkAction, commandBase, normalize, setPolicySpec } from '../src/core/policy.js';

test.afterEach(() => {
  setPolicySpec(null);
});

test('splitCommand：按空格切；引号内不切，引号被剥掉', () => {
  assert.deepEqual(splitCommand('git status'), { bin: 'git', args: ['status'] });
  assert.deepEqual(splitCommand('  ls   -la  '), { bin: 'ls', args: ['-la'] });
  assert.deepEqual(splitCommand('node -e "console.log(1)"'), {
    bin: 'node',
    args: ['-e', 'console.log(1)'],
  });
  assert.deepEqual(splitCommand("node -e 'a b'"), { bin: 'node', args: ['-e', 'a b'] });
});

test('白名单前缀精确匹配；"*" 表示不限；借壳（bash -c）也挡得住', () => {
  assert.equal(commandBase('/usr/bin/ls -la'), 'ls');
  assert.equal(commandBase('C:\\Windows\\node.exe -v'), 'node.exe');
  assert.deepEqual(commandAllowed('ls -la', ['ls']), { ok: true, base: 'ls', matched: 'ls' });
  assert.equal(commandAllowed('rm -rf /', ['ls']).ok, false);
  assert.equal(commandAllowed('rm -rf /', ['*']).ok, true);
  assert.equal(commandAllowed('bash -c "ls"', ['ls']).ok, false, '白名单里没有 bash 就不许借壳');
  assert.equal(commandAllowed('sh -c "ls"', ['ls', 'node']).ok, false);
  // v3 M2.6：两词形式 —— 前缀精确匹配
  assert.equal(commandAllowed('git status --short', ['git status']).ok, true);
  assert.equal(commandAllowed('git push origin main', ['git status']).ok, false);
  assert.equal(commandAllowed('git status', ['git']).ok, true, '只写一个词 = 该命令全都放行');
});

test('白名单外：工具层直接拒（网关之外的第二道）', async () => {
  setPolicySpec(normalize({ exec: { allowCommands: [] } }));
  const out = String(await bashTool.invoke({ command: 'node --version' }));
  assert.ok(out.startsWith('ERROR'), out);
  assert.ok(out.includes('exec.allowCommands'), out);
});

test('白名单内：真能跑，退出码 0', async () => {
  setPolicySpec(normalize({ exec: { allowCommands: ['node'] } }));
  const out = String(await bashTool.invoke({ command: 'node --version' }));
  assert.ok(/v\d+\./.test(out), out);
  assert.ok(out.includes('[退出码 0]'), out);
});

test('非 0 退出码如实返回（不当成失败藏起来）', async () => {
  setPolicySpec(normalize({ exec: { allowCommands: ['node'] } }));
  const out = String(await bashTool.invoke({ command: 'node -e "process.exit(3)"' }));
  assert.ok(out.includes('[退出码 3]'), out);
});

test('超时：杀掉并说明，不让一次调用把进程拖死', async () => {
  setPolicySpec(normalize({ exec: { allowCommands: ['node'] } }));
  const out = String(
    await bashTool.invoke({ command: 'node -e "setTimeout(() => {}, 5000)"', timeout_ms: 300 }),
  );
  assert.ok(out.includes('超时'), out);
});

test('输出超上限就截断（工具结果是全价 token，不能倒进上下文）', async () => {
  setPolicySpec(normalize({ exec: { allowCommands: ['node'] } }));
  const out = String(
    await bashTool.invoke({
      command: `node -e "console.log('x'.repeat(${BASH_OUTPUT_MAX * 3}))"`,
    }),
  );
  assert.ok(out.includes('截断'), out.slice(0, 200));
  assert.ok(out.length < BASH_OUTPUT_MAX + 400, `输出长度 ${out.length}`);
});

test('网关层：装了 shell 也要「agent 规则 + 命令白名单」同时过关', () => {
  const action = {
    kind: 'exec' as const,
    target: 'ls -la',
    by: 'A' as const,
    capability: 'shell' as const,
    tool: 'bash',
  };

  // 内置默认：agents.A.exec 没写 → 落 default = deny
  assert.equal(checkAction(action, DEFAULT_SPEC).allow, false);

  // 放开 agent 但白名单空 → 仍拒，而且规则指向白名单
  const openAgent = normalize({ agents: { A: { exec: 'allow' } } });
  const v1 = checkAction(action, openAgent);
  assert.equal(v1.allow, false);
  assert.equal(v1.rule, 'exec.allowCommands');

  // 白名单里写上这条命令 → 放行
  const withCmd = normalize({ agents: { A: { exec: 'allow' } }, exec: { allowCommands: ['ls'] } });
  assert.equal(checkAction(action, withCmd).allow, true);

  // "*" 也表示不限
  const star = normalize({ agents: { A: { exec: 'allow' } }, exec: { allowCommands: ['*'] } });
  assert.equal(checkAction({ ...action, target: 'rm -rf /' }, star).allow, true);
});

/* ------------------------------------------------------------------------- *
 * v4.7：Windows 上的真实可执行文件解析
 *
 * npm / npx / yarn 在 Windows 上是 .cmd，`spawn('npm')` 不会按 PATHEXT 解析，
 * 直接 ENOENT。这里锁住解析、cmd.exe 启动与参数边界。
 * ------------------------------------------------------------------------- */

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hive-bash-'));
  try {
    return fn(dir);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
}

test('resolveExecutable：Windows 按 PATHEXT 解析 npm -> npm.cmd', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'tool'), '');
    writeFileSync(join(dir, 'tool.cmd'), '@echo off\r\n');
    const env = { PATH: dir, PATHEXT: '.EXE;.CMD' } as NodeJS.ProcessEnv;

    assert.equal(resolveExecutable('tool', env, dir, 'win32'), join(dir, 'tool.cmd'));
    assert.equal(resolveExecutable('tool', env, dir, 'linux'), join(dir, 'tool'));
    assert.equal(resolveExecutable('missing', env, dir, 'win32'), null);
  });
});

test('planCommand：.cmd 经 cmd.exe，参数逐条加引号；危险字符直接拒绝', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'tool.cmd'), '@echo off\r\n');
    const env = {
      PATH: dir,
      PATHEXT: '.CMD',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    } as NodeJS.ProcessEnv;

    const plan = planCommand('tool', ['a b', 'plain'], env, dir, 'win32');
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.command, 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(plan.viaCmd, true);
    assert.deepEqual(plan.args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
    assert.ok(plan.args[4]!.includes(`"${join(dir, 'tool.cmd')}"`), plan.args[4]);
    assert.ok(plan.args[4]!.includes('"a b"'), plan.args[4]);

    const pct = planCommand('tool', ['100%'], env, dir, 'win32');
    assert.equal(pct.ok, false);
    assert.ok(!pct.ok && pct.error.includes('%'), 'cmd 会展开 %VAR%，不能放行');

    const quote = planCommand('tool', ['a"b'], env, dir, 'win32');
    assert.equal(quote.ok, false, '引号会打乱 cmd 的参数边界');
  });
});

test('runCommand：跨平台 fixture 能真跑（Windows .cmd / POSIX .sh）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-bash-'));
  try {
    let script: string;
    if (process.platform === 'win32') {
      script = join(dir, 'probe.cmd');
      writeFileSync(script, '@echo off\r\necho [%~1] [%~2]\r\n');
    } else {
      script = join(dir, 'probe.sh');
      writeFileSync(script, '#!/bin/sh\necho "[$1] [$2]"\n');
      chmodSync(script, 0o755);
    }
    const r = await runCommand(script, ['a b', 'plain'], {
      cwd: dir,
      timeoutMs: 5000,
      env: process.env,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('[a b] [plain]'), r.stdout);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
});

test('runCommand：找不到命令返回中文原因，不抛异常', async () => {
  const r = await runCommand('hive-no-such-command-xyz', [], {
    cwd: tmpdir(),
    timeoutMs: 1000,
    env: process.env,
  });
  assert.equal(r.code, null);
  assert.ok(r.stderr.includes('找不到命令'), r.stderr);
});

test('childEnv：Windows 关键变量透传，敏感值仍被过滤', () => {
  const env = childEnv(
    {
      PATH: 'x',
      APPDATA: 'a',
      LOCALAPPDATA: 'l',
      ProgramFiles: 'p',
      DEEPSEEK_API_KEY: 'k',
      GITHUB_TOKEN: 't',
    } as NodeJS.ProcessEnv,
    [],
  );
  assert.equal(env['APPDATA'], 'a');
  assert.equal(env['LOCALAPPDATA'], 'l');
  assert.equal(env['ProgramFiles'], 'p');
  assert.equal(env['DEEPSEEK_API_KEY'], undefined);
  assert.equal(env['GITHUB_TOKEN'], undefined);
});

test('输出上限：stdout 与 stderr 合计不超过 BASH_OUTPUT_MAX', async () => {
  setPolicySpec(normalize({ exec: { allowCommands: ['node'] } }));
  const out = String(
    await bashTool.invoke({
      command: `node -e "process.stdout.write('x'.repeat(3000)); process.stderr.write('y'.repeat(3000))"`,
    }),
  );
  assert.ok(out.includes('截断'), out.slice(0, 200));
  assert.ok(out.length < BASH_OUTPUT_MAX + 400, `输出长度 ${out.length}`);
});
