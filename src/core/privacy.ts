/**
 * 隐私模式（Windows，docs/PRIVACY-DESIGN.md）。
 *
 * 为什么要有这个文件：`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`
 * **只能作用于调用进程自己拥有的窗口**。终端窗口属于 WindowsTerminal.exe，
 * 从外部调用会返回 FALSE（实测）。所以 hive 自己开一个 WinForms 窗口，
 * 让窗口自己设置 WDA，再通过四个文件与主进程对话。
 *
 * 协议（都在 `.hive/privacy/`）：
 *   transcript.txt  hive → 窗口   完整对话
 *   inbox.txt       窗口 → hive   一条问题
 *   inbox.seq       窗口 → hive   单调序号（防重复）
 *   closed.flag     窗口 → hive   窗口已关闭
 *
 * 对话内容**不写 stdout、不写账本的正文列** —— 这是这个模式存在的意义。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRIVACY_DIR = '.hive/privacy';

export interface PrivacyPaths {
  dir: string;
  transcript: string;
  inbox: string;
  seq: string;
  closed: string;
  script: string;
  status: string;
}

export function privacyPaths(cwd = process.cwd()): PrivacyPaths {
  const dir = resolve(cwd, PRIVACY_DIR);
  return {
    dir,
    transcript: join(dir, 'transcript.txt'),
    inbox: join(dir, 'inbox.txt'),
    seq: join(dir, 'inbox.seq'),
    closed: join(dir, 'closed.flag'),
    script: join(dir, 'privacy-bridge.ps1'),
    status: join(dir, 'window.status'),
  };
}

/** WDA 是 Win32 API；其它平台直接拒绝，不假装支持 */
export function privacySupported(platform = process.platform): boolean {
  return platform === 'win32';
}

export function ensurePrivacyDir(p: PrivacyPaths): void {
  mkdirSync(p.dir, { recursive: true });
}

/** 新会话：清掉上一轮的桥接文件（目录保留） */
export function resetPrivacySession(p: PrivacyPaths): void {
  for (const f of [p.transcript, p.inbox, p.seq, p.closed, p.status]) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* 清不掉不影响启动 */
    }
  }
}

export interface Inbox {
  seq: number;
  text: string;
}

/** 读窗口提交的问题；缺文件 / 序号坏了都返回 null（保守：不处理） */
export function readInbox(p: PrivacyPaths): Inbox | null {
  try {
    const n = Number.parseInt(readFileSync(p.seq, 'utf8').trim(), 10);
    if (!Number.isFinite(n)) return null;
    return { seq: n, text: readFileSync(p.inbox, 'utf8') };
  } catch {
    return null;
  }
}

export type TranscriptWho = 'you' | 'ai' | 'error' | 'status';

export function appendTranscript(p: PrivacyPaths, who: TranscriptWho, text: string): void {
  appendFileSync(p.transcript, `[${who}] ${text.trimEnd()}\n\n`, 'utf8');
}

export function windowClosed(p: PrivacyPaths): boolean {
  return existsSync(p.closed);
}

export function writeBridgeScript(p: PrivacyPaths): void {
  ensurePrivacyDir(p);
  writeFileSync(p.script, BRIDGE_SCRIPT, 'utf8');
}

/* ------------------------------------------------------------------------- *
 * v4.5 TUI 隐私窗口
 *
 * classic 那条路（上面的文件桥接）是 window 里自绘聊天框：能看到对话，但看不到
 * 工具调用的实时输出，斜杠命令也没有。v4.5 把真正的 hive 终端搬进防录屏窗口：
 *
 *   node dist/cli.js (当前进程)
 *     └─ cmd /c start powershell -File privacy-window\window.ps1 -Spec <json>
 *          └─ WinForms 窗口 + WDA_EXCLUDEFROMCAPTURE
 *               └─ WebView2 + xterm.js
 *                    ↕ ConPTY
 *               pty_bridge.py → node dist/cli.js --privacy-child
 *
 * 子进程带 --privacy-child：跳过启动菜单，并且账本只记占位符。
 * ------------------------------------------------------------------------- */

export interface TuiWindowOptions {
  /** 可执行文件，通常是 process.execPath（node.exe） */
  command: string;
  /** 追加参数，例如 [<dist/cli.js>, '--privacy-child'] */
  args?: string[];
  workDir?: string;
  title?: string;
}

export interface TuiWindowResult {
  ok: boolean;
  script: string;
  spec?: string;
  /** 窗口回报的最后状态（webview-ready / running / child-exited / failed） */
  state?: string;
  /** false = 窗口自己确认没上 WDA（HIVE_PRIVACY_NO_PROTECT 或设置失败） */
  excluded?: boolean;
  /** 启动成功但有需要知道的附带情况 */
  warning?: string;
  reason?: string;
  logHint?: string;
}

export interface WindowStatus {
  state?: string;
  excluded: boolean;
  affinity?: string;
  hostPid?: number;
  winPid?: number;
  hwnd?: string;
  at?: string;
  reason?: string;
  note?: string;
  raw: string;
}

/**
 * 读窗口写下的状态行（key=value，单行）。
 * 窗口是独立进程、独立日志，启动器靠这个文件确认「它到底起来没有」。
 */
export function readWindowStatus(p: PrivacyPaths): WindowStatus | null {
  try {
    const raw = readFileSync(p.status, 'utf8').trim();
    if (!raw) return null;
    const map = new Map<string, string>();
    for (const part of raw.split(/\s+/)) {
      const i = part.indexOf('=');
      if (i > 0) map.set(part.slice(0, i), part.slice(i + 1));
    }
    const num = (k: string): number | undefined => {
      const v = map.get(k);
      if (!v) return undefined;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    };
    const flag = map.get('excluded') ?? '';
    return {
      state: map.get('state'),
      excluded: flag === 'True' || flag === 'true',
      affinity: map.get('affinity'),
      hostPid: num('host_pid'),
      winPid: num('win_pid'),
      hwnd: map.get('hwnd'),
      at: map.get('at'),
      reason: map.get('reason'),
      note: map.get('note'),
      raw,
    };
  } catch {
    return null;
  }
}

/** 窗口真的起来了：页面就绪或终端在跑都算；child-exited 说明窗口在、终端退了 */
const WINDOW_UP = new Set(['webview-ready', 'running', 'child-exited']);

export interface WindowWaitResult {
  ok: boolean;
  state?: string;
  status: WindowStatus | null;
  waitMs: number;
  sawStatus: boolean;
}

/** 轮询状态文件，最多等 timeoutMs；窗口初始化失败会立刻返回，不必等满 */
export async function waitForWindow(p: PrivacyPaths, timeoutMs = 15000): Promise<WindowWaitResult> {
  const start = Date.now();
  let sawStatus = false;
  let last: WindowStatus | null = null;
  for (;;) {
    last = readWindowStatus(p);
    if (last) sawStatus = true;
    const state = last?.state;
    if (state === 'failed') {
      return { ok: false, state, status: last, waitMs: Date.now() - start, sawStatus };
    }
    if (state && WINDOW_UP.has(state)) {
      return { ok: true, state, status: last, waitMs: Date.now() - start, sawStatus };
    }
    if (Date.now() - start >= timeoutMs) {
      return { ok: false, state, status: last, waitMs: Date.now() - start, sawStatus };
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** privacy-window/ 的位置：源码（tsx）与编译产物（dist/）都要找得到 */
export function privacyWindowDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '../../privacy-window'), resolve(here, '../../../privacy-window')];
  for (const c of candidates) {
    if (existsSync(join(c, 'window.ps1'))) return c;
  }
  return candidates[0]!;
}

export function privacyWindowReady(): { ok: boolean; dir: string; reason?: string } {
  const dir = privacyWindowDir();
  const script = join(dir, 'window.ps1');
  if (!existsSync(script)) return { ok: false, dir, reason: `找不到 ${script}` };
  const bridge = join(dir, 'pty_bridge.py');
  if (!existsSync(bridge)) return { ok: false, dir, reason: `找不到 ${bridge}` };
  return { ok: true, dir };
}

/**
 * 启动 TUI 隐私窗口。
 *
 * 命令行参数走 `<privacy dir>/window.json`：powershell → C# → python 三段拼接里
 * 空格路径很容易被拆坏，写文件最稳。
 *
 * 窗口是**后台进程**：`WS_EX_TOOLWINDOW` + `ShowInTaskbar=false`，任务栏和 Alt+Tab
 * 里都没有它，只能 Ctrl+Alt+P 召唤。启动器也不能把窗口挂在终端下面：先走 WMI
 * 创建（脱离 Job Object，关掉终端窗口照样活），起不来再退回 `cmd /c start`。
 */
export async function launchTuiWindow(p: PrivacyPaths, opts: TuiWindowOptions): Promise<TuiWindowResult> {
  const ready = privacyWindowReady();
  const script = join(ready.dir, 'window.ps1');
  if (!ready.ok) return { ok: false, script, reason: ready.reason };

  ensurePrivacyDir(p);
  const spec = join(p.dir, 'window.json');
  writeFileSync(
    spec,
    JSON.stringify(
      {
        command: opts.command,
        args: opts.args ?? [],
        workDir: opts.workDir ?? process.cwd(),
        title: opts.title ?? 'hive - privacy mode',
        statusPath: p.status,
      },
      null,
      2,
    ),
    'utf8',
  );

  // 上一轮留下的 status 会让这次启动误以为「已经起来了」——先清掉。
  try {
    rmSync(p.status, { force: true });
  } catch {
    /* 清不掉就让等待逻辑按 mtime 判断 */
  }

  const logHint = join(ready.dir, 'privacy-launch.log');

  // 先走 WMI：进程由 WmiPrvSE 创建，不属于启动者的 Job Object，
  // 关掉终端（或启动器所在宿主）后窗口继续跑 —— 这才是真的后台进程。
  let pid = spawnViaWmi(script, spec);
  let st = await waitForWindow(p, WINDOW_WAIT_MS);

  if (!st.ok && st.state !== 'failed' && !st.sawStatus) {
    // 窗口进程活着但一个字都没写：把这个静默死掉的实例收掉再走回退路径，
    // 否则它可能还占着单实例互斥体。
    killTree(pid ?? undefined);
    const child = spawnViaCmdStart(script, spec);
    pid = child.pid ?? null;
    st = await waitForWindow(p, WINDOW_WAIT_MS);
  }

  if (st.ok) {
    const warning =
      st.state === 'child-exited'
        ? '窗口已打开，但里面的终端进程当前没在运行（Ctrl+Alt+R 重启）'
        : undefined;
    return { ok: true, script, spec, state: st.state, excluded: st.status?.excluded, warning };
  }

  if (st.state === 'failed') {
    return {
      ok: false,
      script,
      spec,
      state: st.state,
      reason: st.status?.reason ?? '窗口初始化失败',
      logHint,
    };
  }

  return {
    ok: false,
    script,
    spec,
    state: st.state,
    reason: `窗口在 ${Math.round(st.waitMs / 1000)}s 内没有回报状态`,
    logHint,
  };
}

const WINDOW_WAIT_MS = 15000;

/**
 * 用 WMI 创建窗口进程。
 *
 * 为什么不是 `spawn(..., { detached: true })`：Windows 上 detached 只表示「新进程组」，
 * 子进程仍然留在父进程的 Job Object 里。宿主（终端、IDE、脚本运行器）退出时若 job
 * 带 KILL_ON_JOB_CLOSE，窗口会被一起带走 —— 实测启动器一退出窗口就没了。
 * WmiPrvSE 创建进程时不在那个 job 里，所以窗口才是真后台。
 *
 * 返回新进程 pid（拿不到返回 null，调用方仍继续等状态）。
 */
function spawnViaWmi(script: string, spec: string): number | null {
  const cmdline = [
    'powershell.exe',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    `"${script}"`,
    '-Spec',
    `"${spec}"`,
  ].join(' ');
  const literal = cmdline.replace(/'/g, "''");
  const ps =
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${literal}' }; ` +
    'if ($r.ReturnValue -ne 0) { Write-Output "0"; exit 1 }; Write-Output $r.ProcessId';
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30000,
    });
    const pid = Number.parseInt((r.stdout ?? '').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** 回退路径：`start` 会创建独立控制台会话，与用户双击 .cmd 完全同一条路径 */
function spawnViaCmdStart(script: string, spec: string): ChildProcess {
  const child = spawn(
    'cmd.exe',
    ['/c', 'start', '', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-Spec', spec],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  return child;
}

/** 收掉一个没起来的窗口进程树（powershell 死了，它拉起的 python/node 也不能留） */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    /* 已经退出了 */
  }
}

/** 窗口里那一份 hive 的启动参数：跳过菜单 + 账本脱敏 */
export function tuiChildArgs(entry: string, as: string | null): string[] {
  const args = [entry, '--privacy-child'];
  if (as) args.push('--as', as);
  return args;
}

/** 启动窗口：detached，主进程继续轮询；stdio 全部忽略，终端不会被窗口污染 */
export function launchPrivacyWindow(p: PrivacyPaths): ChildProcess {
  // 用 `cmd /c start` 而不是直接 spawn powershell：
  // 直接 spawn + detached 时，PowerShell 拿不到正常的交互式控制台，
  // WinForms 会静默退出（实测进程在了、窗口不出现）。
  // `start` 会创建独立的控制台会话，与用户双击 .cmd 完全同一条路径。
  const child = spawn(
    'cmd.exe',
    [
      '/c',
      'start',
      '',
      'powershell.exe',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Minimized',
      '-File',
      p.script,
      '-Dir',
      p.dir,
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  return child;
}

/**
 * 桥接窗口脚本（内嵌，运行时写到 .hive/privacy/）。
 *
 * 三个关键点：
 *   1. `ShowWindow(SW_SHOW)` —— 覆盖 `-WindowStyle Hidden` 带进来的 STARTUPINFO SW_HIDE
 *   2. `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` —— 录屏里不可见
 *   3. 只读写桥接文件，不碰 hive 的其它状态
 */
export const BRIDGE_SCRIPT = `param([string]$Dir)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$src = @'
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class PrivacyBridgeForm : Form
{
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);
    [DllImport("user32.dll")]
    static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")]
    static extern bool ReleaseCapture();
    [DllImport("user32.dll")]
    static extern IntPtr SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);
    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    const uint WDA_EXCLUDEFROMCAPTURE = 0x11;
    const int WM_HOTKEY = 0x0312;
    const int HOTKEY_ID = 1;
    const int HOTKEY_QUIT = 2;

    readonly string _dir;
    RichTextBox _log;
    TextBox _input;
    Label _status;
    DateTime _lastWrite = DateTime.MinValue;
    int _seq;

    string P(string name) { return Path.Combine(_dir, name); }

    public PrivacyBridgeForm(string dir)
    {
        _dir = dir;
        _seq = ReadSeq();

        Text = "hive privacy";
        FormBorderStyle = FormBorderStyle.None;
        TopMost = true;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(920, 640);
        BackColor = Color.FromArgb(18, 18, 18);
        Padding = new Padding(14);

        _log = new RichTextBox();
        _log.Dock = DockStyle.Fill;
        _log.ReadOnly = true;
        _log.BackColor = Color.FromArgb(18, 18, 18);
        _log.ForeColor = Color.Gainsboro;
        _log.BorderStyle = BorderStyle.None;
        _log.Font = new Font("Consolas", 11f);
        _log.ScrollBars = RichTextBoxScrollBars.Vertical;

        _input = new TextBox();
        _input.Multiline = true;
        _input.Height = 84;
        _input.Dock = DockStyle.Bottom;
        _input.BackColor = Color.FromArgb(28, 28, 28);
        _input.ForeColor = Color.White;
        _input.BorderStyle = BorderStyle.FixedSingle;
        _input.Font = new Font("Consolas", 11f);
        _input.ScrollBars = ScrollBars.Vertical;

        _status = new Label();
        _status.Dock = DockStyle.Bottom;
        _status.Height = 22;
        _status.ForeColor = Color.Gray;
        _status.Text = "Ctrl+Enter send | Ctrl+Alt+P show/hide | Ctrl+Alt+Q quit";

        Controls.Add(_status);
        Controls.Add(_input);
        Controls.Add(_log);

        KeyPreview = true;
        KeyDown += OnKeyDown;
        _input.KeyDown += OnKeyDown;
        _log.KeyDown += OnKeyDown;
        MouseDown += OnMouseDown;

        var timer = new Timer();
        timer.Interval = 400;
        timer.Tick += (s, e) => LoadTranscript();
        timer.Start();

        FormClosed += (s, e) =>
        {
            try { File.WriteAllText(P("closed.flag"), "1"); } catch { }
        };

        LoadTranscript();
    }

    int ReadSeq()
    {
        try
        {
            int n;
            if (int.TryParse(File.ReadAllText(P("inbox.seq")).Trim(), out n)) return n;
        }
        catch { }
        return 0;
    }

    void LoadTranscript()
    {
        try
        {
            string f = P("transcript.txt");
            if (!File.Exists(f)) return;
            DateTime t = File.GetLastWriteTimeUtc(f);
            if (t == _lastWrite) return;
            _lastWrite = t;
            string text = File.ReadAllText(f);
            if (_log.Text != text)
            {
                _log.Text = text;
                _log.SelectionStart = _log.TextLength;
                _log.ScrollToCaret();
            }
        }
        catch { }
    }

    void Submit()
    {
        string text = _input.Text.Trim();
        if (text.Length == 0) return;
        try
        {
            File.WriteAllText(P("inbox.txt"), text);
            _seq += 1;
            File.WriteAllText(P("inbox.seq"), _seq.ToString());
            _input.Clear();
            _status.Text = "sent (seq " + _seq + ")";
        }
        catch (Exception ex)
        {
            _status.Text = "send failed: " + ex.Message;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ShowWindow(Handle, 5);
        SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE);
        uint aff;
        bool ok = GetWindowDisplayAffinity(Handle, out aff) && aff == WDA_EXCLUDEFROMCAPTURE;
        RegisterHotKey(Handle, HOTKEY_ID, 0x0002 | 0x0001, (uint)Keys.P);
        RegisterHotKey(Handle, HOTKEY_QUIT, 0x0002 | 0x0001, (uint)Keys.Q);
        try
        {
            File.WriteAllText(P("window.status"),
                "excluded=" + ok + " affinity=0x" + aff.ToString("X2") + " dir=" + _dir);
        }
        catch { }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY)
        {
            int id = m.WParam.ToInt32();
            if (id == HOTKEY_ID)
            {
                if (Visible) { Hide(); } else { Show(); Activate(); _input.Focus(); }
            }
            else if (id == HOTKEY_QUIT)
            {
                Close();
            }
        }
        base.WndProc(ref m);
    }

    void OnKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Control && e.KeyCode == Keys.Enter) { Submit(); e.SuppressKeyPress = true; }
        else if (e.KeyCode == Keys.Escape) { Hide(); e.SuppressKeyPress = true; }
    }

    void OnMouseDown(object sender, MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left) { ReleaseCapture(); SendMessage(Handle, 0xA1, 0x2, 0); }
    }
}
'@

Add-Type -TypeDefinition $src -ReferencedAssemblies System.Windows.Forms, System.Drawing
$form = [PrivacyBridgeForm]::new($Dir)
[System.Windows.Forms.Application]::Run($form)
`;
