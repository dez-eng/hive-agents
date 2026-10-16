/**
 * 能力网关测试（v3 M2）。零 API。
 *
 * 要证明：两层判据（身份有没有这个能力 / 这一次准不准）、default deny、
 * roots 越界拒、env 覆盖是白名单语义、配置写坏退回内置默认、ask 按拒绝处理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { AGENTS, type CapabilityId } from '../src/core/modules.js';
import {
  DEFAULT_SPEC,
  applyEnv,
  checkAction,
  loadPolicy,
  normalize,
  policyPath,
  setPolicySpec,
  withinRoots,
  type Action,
  type PolicySpec,
} from '../src/core/policy.js';

function action(over: Partial<Action> = {}): Action {
  return {
    kind: 'fs.read',
    target: 'src/core/agent.ts',
    by: 'A',
    capability: 'fs',
    tool: 'read_file',
    ...over,
  };
}

test.afterEach(() => {
  setPolicySpec(null);
});

test('内置默认：default deny，A 读写、B 只读、C 读写、D 只读', () => {
  assert.equal(DEFAULT_SPEC.default, 'deny');
  assert.equal(DEFAULT_SPEC.agents.A!['fs.write'], 'allow');
  assert.equal(DEFAULT_SPEC.agents.B!['fs.write'], 'deny');
  assert.equal(DEFAULT_SPEC.agents.C!['fs.write'], 'allow');
  assert.equal(DEFAULT_SPEC.agents.D!['fs.write'], 'deny');
});

test('放行：A 读 roots 内的文件', () => {
  const v = checkAction(action());
  assert.equal(v.allow, true);
  assert.equal(v.code, 'allow');
  assert.equal(v.rule, 'agents.A.fs.read');
});

test('拒绝：B 装了 fs 也不等于能写', () => {
  const v = checkAction(action({ kind: 'fs.write', by: 'B', tool: 'write_file' }));
  assert.equal(v.allow, false);
  assert.equal(v.code, 'denied');
  assert.equal(v.rule, 'agents.B.fs.write');
});

test('拒绝：身份没装这个能力 —— 网关自己再查一遍', () => {
  const v = checkAction(
    action({ kind: 'delegate', by: 'D', capability: 'delegate', tool: 'delegate', target: 'C' }),
  );
  assert.equal(v.allow, false);
  assert.equal(v.code, 'no-capability');
  assert.equal(v.rule, 'AGENTS.D.capabilities');
});

test('拒绝：roots 之外（越界）', () => {
  const v = checkAction(action({ target: resolve(process.cwd(), '..', 'secret.txt') }));
  assert.equal(v.allow, false);
  assert.equal(v.code, 'out-of-roots');
  assert.equal(v.rule, 'roots');
});

test('借调：只做 mayCall 轻检查（真闸门是令牌 + 预算）', () => {
  const ok = checkAction(
    action({ kind: 'delegate', by: 'A', capability: 'delegate', tool: 'delegate', target: 'C' }),
  );
  assert.equal(ok.allow, true);
  const bad = checkAction(
    action({ kind: 'delegate', by: 'B', capability: 'delegate', tool: 'delegate', target: 'A' }),
  );
  assert.equal(bad.allow, false);
  assert.equal(bad.rule, 'AGENTS.B.mayCall');
});

test('规则可注入：关掉 A 的写，写就被拒', () => {
  setPolicySpec(normalize({ agents: { A: { 'fs.write': 'deny' } } }));
  const v = checkAction(action({ kind: 'fs.write', tool: 'write_file' }));
  assert.equal(v.allow, false);
  assert.equal(v.rule, 'agents.A.fs.write');
});

test('ask：M2 没有确认通道，按拒绝处理但 code 区分', () => {
  setPolicySpec(normalize({ agents: { A: { 'fs.write': 'ask' } } }));
  const v = checkAction(action({ kind: 'fs.write', tool: 'write_file' }));
  assert.equal(v.allow, false);
  assert.equal(v.code, 'ask-pending');
});

test('default 改了也过不了第一关：身份没装的能力照样拒', () => {
  setPolicySpec(normalize({ default: 'allow' }));
  // web 到现在（M2.5）还是「只声明、没实现」，四个身份都没装 —— 拿它当"没这个能力"的样本
  const v = checkAction(
    action({ kind: 'net', capability: 'web', tool: 'fetch', target: 'example.com' }),
  );
  assert.equal(v.code, 'no-capability');
});

test('exec / net 白名单：装了这个能力也要命令/域名对得上', () => {
  const caps = AGENTS.A.capabilities as CapabilityId[];
  caps.push('shell');
  try {
    setPolicySpec(normalize({ default: 'allow', exec: { allowCommands: ['ls'] } }));
    assert.equal(
      checkAction(action({ kind: 'exec', capability: 'shell', tool: 'bash', target: 'ls -la' })).allow,
      true,
    );
    assert.equal(
      checkAction(action({ kind: 'exec', capability: 'shell', tool: 'bash', target: 'rm -rf /' })).allow,
      false,
    );
  } finally {
    caps.pop();
  }
});

test('环境变量覆盖是白名单语义：列出的允许，其余一律收回', () => {
  const spec = applyEnv(DEFAULT_SPEC, { HIVE_POLICY_WRITE: 'C' } as NodeJS.ProcessEnv);
  assert.equal(spec.agents.C!['fs.write'], 'allow');
  assert.equal(spec.agents.A!['fs.write'], 'deny', '没列出的必须被收回');
  assert.equal(spec.agents.B!['fs.write'], 'deny');
  // 读没被覆盖，保持原样
  assert.equal(spec.agents.B!['fs.read'], 'allow');
});

test('HIVE_POLICY_ROOTS 用 path.delimiter 分隔', () => {
  const spec = applyEnv(DEFAULT_SPEC, {
    HIVE_POLICY_ROOTS: ['a', 'b'].join(delimiter),
  } as NodeJS.ProcessEnv);
  assert.deepEqual(spec.roots, ['a', 'b']);
});

test('配置路径可用 HIVE_POLICY 换', () => {
  assert.equal(policyPath({} as NodeJS.ProcessEnv), '.hive/policy.json');
  assert.equal(policyPath({ HIVE_POLICY: 'x/y.json' } as NodeJS.ProcessEnv), 'x/y.json');
});

test('配置文件生效：从文件读 roots 与规则', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-pol-'));
  const file = join(dir, 'policy.json');
  writeFileSync(file, JSON.stringify({ roots: ['src'], agents: { B: { 'fs.write': 'allow' } } }), 'utf8');
  try {
    const loaded = loadPolicy(true, { HIVE_POLICY: file } as NodeJS.ProcessEnv);
    assert.equal(loaded.source, file);
    assert.deepEqual(loaded.spec.roots, ['src']);
    assert.equal(loaded.spec.agents.B!['fs.write'], 'allow');
    // 没写的字段落内置默认
    assert.equal(loaded.spec.agents.B!['fs.read'], 'allow');
    assert.equal(loaded.spec.default, 'deny');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('配置写坏了：整份退回内置默认（default deny）+ 一条警告', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-pol-'));
  const file = join(dir, 'policy.json');
  writeFileSync(file, '{ 这不是 JSON', 'utf8');
  try {
    const loaded = loadPolicy(true, { HIVE_POLICY: file } as NodeJS.ProcessEnv);
    assert.equal(loaded.spec.default, 'deny');
    assert.deepEqual(loaded.spec.roots, DEFAULT_SPEC.roots);
    assert.equal(loaded.warnings.length, 1);
    assert.ok(loaded.warnings[0]!.includes('解析失败'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('withinRoots：前缀比较要带分隔符（proj 不该放行 proj-evil）', () => {
  const spec: PolicySpec = normalize({ roots: ['proj'] });
  assert.equal(withinRoots(resolve(process.cwd(), 'proj', 'a.ts'), spec), true);
  assert.equal(withinRoots(resolve(process.cwd(), 'proj'), spec), true);
  assert.equal(withinRoots(resolve(process.cwd(), 'proj-evil', 'a.ts'), spec), false);
});
