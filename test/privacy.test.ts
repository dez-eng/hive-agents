/**
 * 隐私模式（docs/PRIVACY-DESIGN.md）的零 API 测试。
 *
 * 窗口本身无法在 CI 里验证（要 Windows 桌面），这里证明协议与脚本契约：
 *   · 平台判据只放行 Windows
 *   · inbox / transcript / closed 的文件语义
 *   · 桥接脚本里确实有 WDA、ShowWindow 与两个方向的文件名
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BRIDGE_SCRIPT,
  appendTranscript,
  ensurePrivacyDir,
  privacyPaths,
  privacySupported,
  privacyWindowReady,
  readInbox,
  readWindowStatus,
  resetPrivacySession,
  tuiChildArgs,
  waitForWindow,
  windowClosed,
  writeBridgeScript,
  type PrivacyPaths,
} from '../src/core/privacy.js';

function withTmp<T>(fn: (paths: PrivacyPaths) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hive-privacy-'));
  try {
    const p = privacyPaths(dir);
    ensurePrivacyDir(p);
    return fn(p);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
}

test('平台：只有 Windows 支持（WDA 是 Win32 API）', () => {
  assert.equal(privacySupported('win32'), true);
  assert.equal(privacySupported('linux'), false);
  assert.equal(privacySupported('darwin'), false);
});

test('路径：桥接文件全部落在 .hive/privacy 下', () => {
  const p = privacyPaths('/tmp/x');
  const norm = (s: string): string => s.replace(/\\/g, '/');
  for (const f of [p.transcript, p.inbox, p.seq, p.closed, p.script, p.status]) {
    assert.ok(norm(f).includes('.hive/privacy'), f);
  }
});

test('inbox：缺文件 / 坏序号返回 null，正常返回文本', () => {
  withTmp((p) => {
    assert.equal(readInbox(p), null, '还没提交过');

    writeFileSync(p.seq, 'not-a-number');
    writeFileSync(p.inbox, 'hello');
    assert.equal(readInbox(p), null, '序号坏了就保守不处理');

    writeFileSync(p.seq, ' 3 ');
    assert.deepEqual(readInbox(p), { seq: 3, text: 'hello' });
  });
});

test('transcript：追加不覆盖，顺序与标记都在', () => {
  withTmp((p) => {
    appendTranscript(p, 'you', '问');
    appendTranscript(p, 'ai', '答');
    const t = readFileSync(p.transcript, 'utf8');
    assert.ok(t.includes('[you] 问'));
    assert.ok(t.includes('[ai] 答'));
    assert.ok(t.indexOf('[you]') < t.indexOf('[ai]'), '顺序不能反');
  });
});

test('closed：flag 文件即窗口已关闭；reset 清文件但保留目录', () => {
  withTmp((p) => {
    assert.equal(windowClosed(p), false);
    writeFileSync(p.closed, '1');
    assert.equal(windowClosed(p), true);

    appendTranscript(p, 'status', 'x');
    resetPrivacySession(p);
    assert.equal(existsSync(p.transcript), false);
    assert.equal(existsSync(p.closed), false);
    assert.ok(existsSync(p.dir), '目录要留着给下一轮用');
  });
});

test('桥接脚本：落盘内容一致，且包含 WDA / ShowWindow / 双向文件', () => {
  withTmp((p) => {
    writeBridgeScript(p);
    const s = readFileSync(p.script, 'utf8');
    assert.equal(s, BRIDGE_SCRIPT);
    for (const needle of [
      'WDA_EXCLUDEFROMCAPTURE',
      'SetWindowDisplayAffinity',
      'ShowWindow',
      'inbox.seq',
      'closed.flag',
      'Ctrl+Alt+P',
      'transcript.txt',
    ]) {
      assert.ok(s.includes(needle), `桥接脚本缺少 ${needle}`);
    }
  });
});

test('桥接脚本：窗口标题与状态输出约定', () => {
  assert.ok(BRIDGE_SCRIPT.includes('"hive privacy"'), '窗口标题');
  assert.ok(BRIDGE_SCRIPT.includes('window.status'), '自检状态文件');
  assert.ok(BRIDGE_SCRIPT.includes('excluded='), '状态里要有 excluded');
});

/* ------------------------------------------------------------------------- *
 * v4.6：后台窗口的启动握手
 *
 * 窗口是独立进程，启动器唯一能确认「它到底起来没有」的办法就是读它写的
 * window.status。这一段锁的正是那套协议：状态行怎么解析、哪些状态算起来、
 * 失败是否立刻返回、超时是否区分「没状态」与「状态说没起来」。
 * ------------------------------------------------------------------------- */

async function withTmpAsync<T>(fn: (paths: PrivacyPaths) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'hive-privacy-'));
  try {
    const p = privacyPaths(dir);
    ensurePrivacyDir(p);
    return await fn(p);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 下偶尔删不掉 */
    }
  }
}

test('window.status：解析 key=value，缺文件 / 空文件返回 null', () => {
  withTmp((p) => {
    assert.equal(readWindowStatus(p), null, '还没写过状态');
    writeFileSync(p.status, '   \n');
    assert.equal(readWindowStatus(p), null, '空文件不当成状态');

    writeFileSync(
      p.status,
      'state=running excluded=True affinity=0x11 host_pid=4256 win_pid=7812 hwnd=0x80C12 at=2026-10-29T11:04:09',
    );
    const s = readWindowStatus(p);
    assert.ok(s);
    assert.equal(s.state, 'running');
    assert.equal(s.excluded, true);
    assert.equal(s.affinity, '0x11');
    assert.equal(s.hostPid, 4256);
    assert.equal(s.winPid, 7812);
    assert.equal(s.hwnd, '0x80C12');
    assert.equal(s.at, '2026-10-29T11:04:09');
    assert.ok(s.raw.includes('state=running'), '原始行要留着便于排错');
  });
});

test('window.status：excluded=False 与失败原因都保留，坏数字不变成 NaN', () => {
  withTmp((p) => {
    writeFileSync(p.status, 'state=failed excluded=False reason=webview2_missing host_pid=abc');
    const s = readWindowStatus(p);
    assert.ok(s);
    assert.equal(s.state, 'failed');
    assert.equal(s.excluded, false);
    assert.equal(s.reason, 'webview2_missing');
    assert.equal(s.hostPid, undefined, '解析不了的 pid 当没有');
  });
});

test('waitForWindow：页面就绪即成功，不继续等', async () => {
  await withTmpAsync(async (p) => {
    const pending = waitForWindow(p, 3000);
    setTimeout(() => writeFileSync(p.status, 'state=webview-ready excluded=True affinity=0x11'), 200);
    const r = await pending;
    assert.equal(r.ok, true);
    assert.equal(r.state, 'webview-ready');
    assert.equal(r.status?.excluded, true);
    assert.equal(r.sawStatus, true);
    assert.ok(r.waitMs < 3000, '拿到就绪状态后要立刻返回');
  });
});

test('waitForWindow：running / child-exited 也算窗口起来了', async () => {
  await withTmpAsync(async (p) => {
    writeFileSync(p.status, 'state=running excluded=True affinity=0x11');
    const running = await waitForWindow(p, 200);
    assert.equal(running.ok, true);
    assert.equal(running.state, 'running');

    writeFileSync(p.status, 'state=child-exited excluded=True affinity=0x11');
    const exited = await waitForWindow(p, 200);
    assert.equal(exited.ok, true, '窗口在、终端退了，启动仍然算成功');
    assert.equal(exited.state, 'child-exited');
  });
});

test('waitForWindow：failed 立刻返回，不等到超时', async () => {
  await withTmpAsync(async (p) => {
    writeFileSync(p.status, 'state=failed excluded=False reason=pywinpty_missing');
    const t0 = Date.now();
    const r = await waitForWindow(p, 5000);
    assert.equal(r.ok, false);
    assert.equal(r.state, 'failed');
    assert.equal(r.status?.reason, 'pywinpty_missing');
    assert.ok(Date.now() - t0 < 1000, '失败要立刻返回，别让启动器干等 15 秒');
  });
});

test('waitForWindow：始终没有状态就按超时返回，并标明没看到状态', async () => {
  await withTmpAsync(async (p) => {
    const r = await waitForWindow(p, 50);
    assert.equal(r.ok, false);
    assert.equal(r.sawStatus, false);
    assert.equal(r.state, undefined);
    assert.equal(r.status, null);
    assert.ok(r.waitMs >= 50);
  });
});

test('tuiChildArgs：窗口里的 hive 一定带 --privacy-child，--as 原样追加', () => {
  assert.deepEqual(tuiChildArgs('D:/x/dist/cli.js', null), ['D:/x/dist/cli.js', '--privacy-child']);
  assert.deepEqual(tuiChildArgs('D:/x/dist/cli.js', 'C'), [
    'D:/x/dist/cli.js',
    '--privacy-child',
    '--as',
    'C',
  ]);
});

test('privacyWindowReady：仓库里的 window.ps1 与 pty_bridge.py 都在', () => {
  const r = privacyWindowReady();
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.dir.replace(/\\/g, '/').endsWith('/privacy-window'));
  assert.ok(existsSync(join(r.dir, 'window.ps1')), 'window.ps1');
  assert.ok(existsSync(join(r.dir, 'pty_bridge.py')), 'pty_bridge.py');
});
