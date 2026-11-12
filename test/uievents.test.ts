import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parse } from '../src/core/args.js';
import { MemorySink, openUiSinkFromEnv, setUiSink, emitUi, uiSink } from '../src/core/uievents.js';

function tmpFile(name: string): string {
  return join(tmpdir(), `hive-uievents-${process.pid}-${name}`);
}

test('事件通道：没有 HIVE_UI_EVENTS 就不开（正常终端零开销）', () => {
  const old = process.env.HIVE_UI_EVENTS;
  delete process.env.HIVE_UI_EVENTS;
  try {
    assert.equal(openUiSinkFromEnv(), null);
    assert.equal(uiSink(), null);
    // 没有 sink 时 emitUi 是空操作，不能抛
    emitUi({ t: 'turn', text: 'x' });
  } finally {
    if (old !== undefined) process.env.HIVE_UI_EVENTS = old;
  }
});

test('事件通道：开了就写 JSONL，每行一个事件、带 at 时间戳', () => {
  const file = tmpFile('sink.jsonl');
  const old = process.env.HIVE_UI_EVENTS;
  process.env.HIVE_UI_EVENTS = file;
  try {
    const sink = openUiSinkFromEnv();
    assert.ok(sink);
    emitUi({ t: 'turn', text: '实现登录' });
    emitUi({ t: 'think', d: 'We need ' });
    emitUi({ t: 'think_end', chars: 8, ms: 120 });
    sink!.flush();

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    const first = JSON.parse(lines[0]!);
    assert.equal(first.t, 'turn');
    assert.equal(first.text, '实现登录');
    assert.equal(typeof first.at, 'number');
    assert.equal(JSON.parse(lines[1]!).d, 'We need ');
    assert.equal(JSON.parse(lines[2]!).chars, 8);
  } finally {
    setUiSink(null);
    if (old === undefined) delete process.env.HIVE_UI_EVENTS;
    else process.env.HIVE_UI_EVENTS = old;
    rmSync(file, { force: true });
  }
});

test('事件通道：启动时清空上一轮的残留 —— 否则窗口会重放旧对话', () => {
  const file = tmpFile('stale.jsonl');
  writeFileSync(file, '{"t":"turn","text":"上一轮的","at":1}\n', 'utf8');
  const old = process.env.HIVE_UI_EVENTS;
  process.env.HIVE_UI_EVENTS = file;
  try {
    const sink = openUiSinkFromEnv()!;
    sink.flush();
    assert.equal(readFileSync(file, 'utf8'), '');
  } finally {
    setUiSink(null);
    if (old === undefined) delete process.env.HIVE_UI_EVENTS;
    else process.env.HIVE_UI_EVENTS = old;
    rmSync(file, { force: true });
  }
});

test('MemorySink：按类型取事件，测试里当断言用', () => {
  const mem = new MemorySink();
  setUiSink(mem);
  try {
    emitUi({ t: 'think', d: 'a' });
    emitUi({ t: 'tool', name: 'bash' });
    emitUi({ t: 'think', d: 'b' });
    assert.deepEqual(
      mem.of('think').map((e) => e.d),
      ['a', 'b'],
    );
    assert.deepEqual(
      mem.of('tool').map((e) => e.name),
      ['bash'],
    );
  } finally {
    setUiSink(null);
  }
});

test('--ui-events 两种写法都认，且不污染 rest', () => {
  const a = parse(['--ui-events=C:\\Users\\x y\\ev.jsonl', '--privacy-child']);
  assert.equal(a.uiEvents, 'C:\\Users\\x y\\ev.jsonl');
  assert.equal(a.privacyChild, true);
  assert.deepEqual(a.rest, []);

  const b = parse(['--ui-events', 'D:/tmp/ev.jsonl', 'privacy']);
  assert.equal(b.uiEvents, 'D:/tmp/ev.jsonl');
  assert.equal(b.mode, 'privacy');

  const c = parse(['privacy']);
  assert.equal(c.uiEvents, null, '没给就是 null —— 不能默认开一条写不出去的文件');
});

test('事件文件路径由 privacyPaths 给出，落在 .hive/privacy 下', async () => {
  const { privacyPaths } = await import('../src/core/privacy.js');
  const p = privacyPaths('D:/proj');
  assert.ok(p.events.endsWith(join('.hive', 'privacy', 'ui-events.jsonl')));
  assert.ok(existsSync(p.dir) === false, '只是算路径，不该顺手建目录');
});
