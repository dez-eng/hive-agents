/**
 * v3 M1 测试：agent 定义（能力归身份）、独立会话 thread、CLI 入口解析。
 * 全部零 API。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENTS, standaloneAgents, getModule, type AgentId } from '../src/core/modules.js';
import { soloThread, subThread } from '../src/core/handoff.js';
import { newReplState, newReplStateFor } from '../src/core/session.js';
import { parse, resolveAs } from '../src/core/args.js';

test('AGENTS：每个 agent 都有 capability、think 合法、可独立启动（全开）', () => {
  for (const a of Object.values(AGENTS)) {
    assert.ok(a.capabilities.length > 0, `${a.id} 没有 capability`);
    assert.ok(a.standalone, `${a.id} 不可独立启动（2026-10-15 定：全开）`);
    assert.ok(
      a.think === 'off' || a.think === 'low' || a.think === 'high',
      `${a.id} 的 think 不合法：${String(a.think)}`,
    );
    assert.ok(getModule(a.home), `${a.id} 的主模块 ${a.home} 不存在`);
  }
  assert.equal(standaloneAgents().length, 4, '四个身份都该能独立启动');
});

test('capability 是身份的属性，不是模块的 —— 换角色不掉能力', () => {
  assert.ok(!('capabilities' in getModule('assistant')!), '模块表不该带 capability');
  assert.ok(AGENTS.A.capabilities.includes('delegate'));
  assert.ok(AGENTS.B.capabilities.includes('delegate'));
  assert.ok(!AGENTS.C.capabilities.includes('delegate'), 'C 的 mayCall 是空的，不该有 delegate 能力');
});

test('独立会话 thread：solo#<id>，与借调子任务明确区分', () => {
  assert.equal(soloThread('B'), 'solo#B');
  assert.notEqual(soloThread('B'), subThread('main', 'B', 't001-aaaa'));
  assert.ok(!soloThread('B').includes('#t'), '独立会话不带 taskId');
});

test('newReplStateFor：栈底直接是该 agent 的主模块', () => {
  const st = newReplStateFor('solo#C', 'C');
  assert.deepEqual(st.stack, ['fix']);
  assert.equal(st.thread, 'solo#C');
  // 根身份要记住：/new 靠它决定栈底回到谁（否则 D 的会话清一下就变成 A）
  assert.equal(st.rootAgent, 'C');
  assert.equal(newReplState('main').rootAgent, 'A');
  // 与普通会话不同：普通会话栈底是默认模块
  assert.deepEqual(newReplStateFor('solo#D', 'D').stack, ['audit']);
});

test('parse：默认 repl；--as / --continue 被摘出来，不进 rest', () => {
  assert.deepEqual(parse([]), { mode: 'repl', rest: [], as: null, cont: false });

  const p = parse(['--as', 'b', '--continue', 'run', '你好']);
  assert.equal(p.mode, 'run');
  assert.equal(p.as, 'B', '身份会归一成大写');
  assert.equal(p.cont, true);
  assert.deepEqual(p.rest, ['你好']);

  // 纯 --as：进 repl，身份带上
  const q = parse(['--as', 'C']);
  assert.equal(q.mode, 'repl');
  assert.equal(q.as, 'C');

  // 未知子命令按 run 处理（与旧行为一致）
  assert.equal(parse(['随便一句话']).mode, 'run');
  assert.equal(parse(['--help']).mode, 'help');
});

test('resolveAs：不存在或不允许独立启动的身份被拒', () => {
  assert.deepEqual(resolveAs(null), { ok: true, as: null });
  assert.equal(resolveAs('B').ok, true);
  assert.equal(resolveAs('X' as AgentId).ok, false, '不存在的身份要拒');
});
