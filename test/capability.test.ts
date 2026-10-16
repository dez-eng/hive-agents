/**
 * capability 层测试（v3 M2）。零 API。
 *
 * 要证明：工具集由**身份**装配、顺序 = 注册表顺序（前缀字节稳定）、
 * 声明但未实现的 capability 贡献 0 工具、有副作用的工具才有动作类型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENTS } from '../src/core/modules.js';
import {
  ALL_TOOLS,
  CAPABILITIES,
  CAPABILITY_ORDER,
  TOOL_MAP,
  capabilityOfTool,
  declaredOnly,
  kindOf,
  toolNamesFor,
  toolsCharsFor,
} from '../src/core/capability.js';

test('toolsFor：工具只来自该身份声明过的 capability', () => {
  for (const a of Object.values(AGENTS)) {
    for (const n of toolNamesFor(a.id)) {
      const cap = capabilityOfTool(n);
      assert.ok(cap, `${n} 不属于任何 capability`);
      assert.ok(
        a.capabilities.includes(cap),
        `${a.id} 的 ${n} 来自没声明的 ${cap}`,
      );
    }
  }
});

test('工具顺序 = 注册表顺序（顺序即前缀顺序，动它就是作废缓存）', () => {
  for (const a of Object.values(AGENTS)) {
    const expected: string[] = [];
    for (const id of CAPABILITY_ORDER) {
      if (!a.capabilities.includes(id)) continue;
      for (const t of CAPABILITIES[id].tools) expected.push(t.name);
    }
    assert.deepEqual(toolNamesFor(a.id), expected, `${a.id} 的工具顺序不对`);
    // 同一个身份连算两次，逐字节一样
    assert.deepEqual(toolNamesFor(a.id), toolNamesFor(a.id));
  }
});

test('缓存代价跟着身份走：C 最小，A 最大', () => {
  assert.deepEqual(toolNamesFor('C'), ['read_file', 'write_file']);
  assert.ok(toolsCharsFor('C') < toolsCharsFor('D'), 'D 多了搜索');
  assert.ok(toolsCharsFor('D') < toolsCharsFor('A'), 'A 还多算数与借调');
  assert.ok(toolsCharsFor('C') > 0);
});

test('声明但未实现的能力：贡献 0 工具（0 token）', () => {
  assert.deepEqual(declaredOnly(), ['shell', 'web', 'skill']);
  for (const id of declaredOnly()) {
    assert.equal(CAPABILITIES[id].tools.length, 0);
    assert.ok(!ALL_TOOLS.some((t) => capabilityOfTool(t.name) === id));
  }
});

test('ALL_TOOLS / TOOL_MAP：每个注册的工具都能按名分派', () => {
  assert.equal(ALL_TOOLS.length, Object.keys(TOOL_MAP).length);
  for (const t of ALL_TOOLS) assert.ok(TOOL_MAP[t.name], `${t.name} 分派不到`);
  const names = ALL_TOOLS.map((t) => t.name);
  assert.ok(names.includes('grep') && names.includes('glob'), 'search 的两个工具该在');
});

test('kindOf：有副作用的工具有动作类型，计算器没有（不进网关）', () => {
  assert.equal(kindOf('read_file'), 'fs.read');
  assert.equal(kindOf('write_file'), 'fs.write');
  assert.equal(kindOf('grep'), 'fs.read');
  assert.equal(kindOf('glob'), 'fs.read');
  assert.equal(kindOf('delegate'), 'delegate');
  assert.equal(kindOf('calculator'), undefined);
});
