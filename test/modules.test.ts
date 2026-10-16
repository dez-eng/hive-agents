import test from 'node:test';
import assert from 'node:assert/strict';

import { MODULES, getModule, moduleList, fragmentFor, AGENTS } from '../src/core/modules.js';
import {
  ALL_TOOLS,
  TOOL_MAP,
  toolNamesFor,
  toolsCharsFor,
  toolsFor,
} from '../src/core/capability.js';

test('v3 M2：模块表不再带工具 —— 「能干什么」归身份', () => {
  for (const m of moduleList()) {
    assert.ok(!('tools' in m), `${m.id} 还挂着 tools：工具归 AGENTS[i].capabilities，不该在模块上`);
  }
});

test('每个身份引用的工具名都真实存在 —— 拼错就等于权限永远开不出来', () => {
  const names = new Set(ALL_TOOLS.map((t) => t.name));
  for (const a of Object.values(AGENTS)) {
    for (const t of toolNamesFor(a.id)) {
      assert.ok(names.has(t), `${a.id} 引用了不存在的工具 ${t}`);
    }
  }
});

test('工具集按能力装配：C 只有文件工具，D 有搜索，A 有算数', () => {
  assert.deepEqual(toolNamesFor('C'), ['read_file', 'write_file', 'edit_file', 'bash']);
  assert.ok(toolNamesFor('D').includes('grep'), 'D 该有搜索能力');
  assert.ok(!toolNamesFor('D').includes('write_file') === false, 'D 装 fs，schema 里有 write_file');
  assert.ok(toolNamesFor('A').includes('calculator'));
  assert.ok(!toolNamesFor('C').includes('delegate'), 'C 的 mayCall 是空的');
  assert.ok(toolsCharsFor('C') < toolsCharsFor('A'), 'C 的工具 schema 该比 A 小');
});

test('模块 id 与表里的键一致（/use 靠它找）', () => {
  for (const [key, m] of Object.entries(MODULES)) {
    assert.equal(key, m.id);
    assert.ok(getModule(m.id), `${m.id} 查不回来`);
  }
});

test('角色片非空且够短 —— 它每轮都在 prompt 里', () => {
  for (const m of moduleList()) {
    assert.ok(m.fragment.length > 4, `${m.id} 的角色片太短，等于没写`);
    assert.ok(m.fragment.length < 120, `${m.id} 的角色片太长，每轮都在为它付钱`);
  }
});

test('尾部片段格式固定，便于人认也便于模型认', () => {
  const f = fragmentFor(MODULES['recon']!);
  assert.ok(f.startsWith('\n\n【模块:recon'));
  assert.ok(f.includes('｜侦察'));
});

test('calculator 只算数，且拒绝任何非算式内容', async () => {
  const calc = TOOL_MAP['calculator']!;
  assert.equal(await calc.invoke({ expression: '(1+2)*3' }), '9');
  assert.equal(await calc.invoke({ expression: '10 % 3' }), '1');
  assert.equal(await calc.invoke({ expression: '2*-3' }), '-6');
  assert.equal(await calc.invoke({ expression: '-(-5)' }), '5');
  const bad = String(await calc.invoke({ expression: 'process.exit(1)' }));
  assert.ok(bad.startsWith('ERROR'), `不该接受这种输入：${bad}`);
  const bad2 = String(await calc.invoke({ expression: '1+2; rm -rf /' }));
  assert.ok(bad2.startsWith('ERROR'));
});

test('read_file 挡住越界路径', async () => {
  const rf = TOOL_MAP['read_file']!;
  const escape = String(await rf.invoke({ path: '../../etc/passwd' }));
  assert.ok(escape.startsWith('ERROR'), `越界应该被挡：${escape}`);
  const missing = String(await rf.invoke({ path: 'definitely-not-here.txt' }));
  assert.ok(missing.startsWith('ERROR'));
});
