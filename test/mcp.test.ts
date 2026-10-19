/**
 * v4 M4.2 MCP 的零 API 测试。
 *
 * 不连真 server：只测「配置解析 / JSON Schema→zod / 命名与分派 / 能力装配 / policy」。
 * 真机连接与调用在 M4.2 验收时单独跑（test/fixtures 里的 echo server）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import {
  CAPABILITIES,
  capabilityOfTool,
  enableMcpFor,
  kindOf,
  mcpServerOf,
  mcpToolName,
  registerMcpTools,
  toolsFor,
  type AnyTool,
} from '../src/core/capability.js';
import { AGENTS } from '../src/core/modules.js';
import { jsonSchemaToZod } from '../src/core/mcp.js';
import { parseSettings } from '../src/core/settings.js';
import { DEFAULT_SPEC, checkAction, setPolicySpec } from '../src/core/policy.js';

const origA = [...AGENTS.A.capabilities];
const origB = [...AGENTS.B.capabilities];

function restore(): void {
  AGENTS.A.capabilities = [...origA];
  AGENTS.B.capabilities = [...origB];
  registerMcpTools([]);
  setPolicySpec(null);
}

test.after(restore);

test('settings：mcp.servers 解析、agents 默认 A、allowServers 为空时警告', () => {
  const ok = parseSettings({
    mcp: {
      servers: {
        fs: { command: 'npx', args: ['-y', 'server-filesystem'], env: { TOKEN: 'x' }, cwd: '.' },
      },
    },
  });
  assert.ok(ok.ok);
  assert.equal(ok.value.mcp?.agents[0], 'A');
  assert.equal(ok.value.mcp?.servers['fs']?.command, 'npx');
  assert.deepEqual(ok.value.mcp?.servers['fs']?.args, ['-y', 'server-filesystem']);
  assert.equal(ok.value.mcp?.allowServers.length, 0);
  assert.ok(ok.warnings.some((w) => w.includes('allowServers')));
});

test('settings：写坏给原因，不猜', () => {
  assert.equal(parseSettings([]).ok, false);
  assert.equal(parseSettings({ mcp: { servers: { fs: {} } } }).ok, false);
  assert.equal(parseSettings({ mcp: { servers: { fs: { command: 'x' } }, agents: 'A' } }).ok, false);
  assert.equal(parseSettings({ price: { m: { in_hit: { peak: 1 } } } }).ok, false);
});

test('JSON Schema→zod：object/required/optional/enum/integer/array', () => {
  const s = jsonSchemaToZod({
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      n: { type: 'integer' },
      mode: { type: 'string', enum: ['read', 'write'] },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['path'],
  });

  assert.equal(s.safeParse({ path: 'a' }).success, true, '只给必填项应该过');
  assert.equal(s.safeParse({}).success, false, '缺必填项该拒');
  assert.equal(s.safeParse({ path: 'a', mode: 'oops' }).success, false, 'enum 外该拒');
  assert.equal(s.safeParse({ path: 'a', n: 1.5 }).success, false, 'integer 该拒小数');
  assert.equal(s.safeParse({ path: 'a', tags: ['x'] }).success, true);
  assert.equal(s.safeParse({ path: 'a', extra: true }).success, true, 'passthrough 不吞未知参数');
});

test('工具命名与分派：mcp__server__tool；kind=mcp；capability=mcp', () => {
  const name = mcpToolName('my-server', 'read file');
  assert.equal(name, 'mcp__my_server__read_file');
  assert.equal(mcpServerOf(name), 'my_server');
  assert.equal(mcpServerOf('read_file'), undefined);
  assert.equal(kindOf(name), 'mcp');
  assert.equal(capabilityOfTool(name), 'mcp');
  assert.equal(kindOf('read_file'), 'fs.read', '普通工具仍走静态表');
});

test('能力装配：注册工具 + 只给指定身份开 MCP', () => {
  const fake = {
    name: 'mcp__echo__echo',
    description: '回显',
    schema: z.object({ text: z.string() }),
    invoke: async () => 'ok',
  } as unknown as AnyTool;

  registerMcpTools([fake]);
  const enabled = enableMcpFor(['A']);
  assert.deepEqual(enabled, ['A']);
  assert.ok(toolsFor('A').some((t) => t.name === 'mcp__echo__echo'), 'A 该装上 MCP 工具');
  assert.ok(!toolsFor('B').some((t) => t.name === 'mcp__echo__echo'), 'B 没开就不该有');
  assert.equal(CAPABILITIES.mcp.tools.length, 1);
});

test('policy：mcp.allowServers 放行；身份显式 deny 优先；默认拒', () => {
  AGENTS.A.capabilities.push('mcp');
  AGENTS.B.capabilities.push('mcp');
  const spec = {
    ...DEFAULT_SPEC,
    mcp: { allowServers: ['echo'] },
  };

  const ok = checkAction(
    { kind: 'mcp', target: 'echo', by: 'A', capability: 'mcp', tool: 'mcp__echo__echo' },
    spec,
  );
  assert.equal(ok.allow, true);

  const notListed = checkAction(
    { kind: 'mcp', target: 'other', by: 'A', capability: 'mcp', tool: 'mcp__other__x' },
    spec,
  );
  assert.equal(notListed.allow, false, '不在白名单该拒');

  const denied = checkAction(
    { kind: 'mcp', target: 'echo', by: 'B', capability: 'mcp', tool: 'mcp__echo__echo' },
    { ...spec, agents: { ...spec.agents, B: { ...spec.agents.B, mcp: 'deny' } } },
  );
  assert.equal(denied.allow, false, '身份显式 deny 要盖过 server 白名单');

  const noCap = checkAction(
    { kind: 'mcp', target: 'echo', by: 'C', capability: 'mcp', tool: 'mcp__echo__echo' },
    spec,
  );
  assert.equal(noCap.allow, false, '没装 mcp 能力的身份连门都到不了');
  assert.equal(noCap.code, 'no-capability');
});
