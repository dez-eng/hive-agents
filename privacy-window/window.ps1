#requires -Version 5.1
<#
 window.ps1 - run any console program inside a window excluded from screen capture.

 Used by hive: the real `hive` TUI (node dist/cli.js) is hosted in a ConPTY by
 pty_bridge.py and rendered by xterm.js, inside a WinForms window that this process
 owns -- the only way SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) can work.

 The window is a tool window: no taskbar button, no Alt+Tab entry. It lives in the
 background and is summoned with a hotkey, which is what "privacy mode" should feel
 like -- nothing announcing itself to whoever looks at the screen.

 Hotkeys:
   Ctrl+Alt+P   show / hide
   Ctrl+Alt+R   restart the hosted terminal (after a crash)
   Ctrl+Alt+Q   quit (kills the child process tree)

 Params:
   -Command     executable to run (required), e.g. C:\Program Files\nodejs\node.exe
   -CommandArgs additional arguments, one string, quoted by the caller
   -WorkDir     working directory for the child (default: current dir)
   -Title       window title (default: "hive - privacy mode")
   -StatusPath  where to write the "excluded=..." status line
#>
param(
  [string]$Spec = "",
  [string]$Command = "",
  [string]$CommandArgs = "",
  [string]$WorkDir = "",
  [string]$Title = "hive - privacy mode",
  [string]$StatusPath = "",
  [int]$Cols = 120,
  [int]$Rows = 34
)

$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$assetDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ScriptVersion = "1.2.0"

# -Spec 指向一个 JSON（hive 写 .hive/privacy/window.json）：命令行参数走文件，
# 免得路径里的空格在 powershell.exe -> C# -> python 三段拼接里被拆坏。
if (-not [string]::IsNullOrWhiteSpace($Spec)) {
  try {
    $specJson = Get-Content -LiteralPath $Spec -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($specJson.command) { $Command = [string]$specJson.command }
    if ($specJson.args) {
      $quoted = @()
      foreach ($a in $specJson.args) {
        $s = [string]$a
        if ($s -match '\s') { $quoted += ('"' + $s + '"') } else { $quoted += $s }
      }
      $CommandArgs = ($quoted -join ' ')
    }
    if ($specJson.workDir) { $WorkDir = [string]$specJson.workDir }
    if ($specJson.title) { $Title = [string]$specJson.title }
    if ($specJson.statusPath) { $StatusPath = [string]$specJson.statusPath }
  } catch {
    Write-Host ("[privacy] 读不了 spec: " + $_.Exception.Message)
    exit 1
  }
}

if ([string]::IsNullOrWhiteSpace($WorkDir)) { $WorkDir = (Get-Location).Path }
# The launcher strips the trailing backslash of a drive root ("C:\" -> "C:") so that
# PowerShell's argument parser does not swallow the closing quote; put it back for
# CreateProcess, which wants a full directory path.
if ($WorkDir -match '^[A-Za-z]:$') { $WorkDir += '\' }
if ([string]::IsNullOrWhiteSpace($StatusPath)) { $StatusPath = Join-Path $assetDir "window.status" }

# Everything below can fail silently when the launcher starts us with -WindowStyle Hidden,
# so every step lands in a log file the user (and the next debugging session) can read.
$logPath = Join-Path $assetDir "privacy-launch.log"
$logMaxBytes = 4MB
try {
  if (Test-Path -LiteralPath $logPath) {
    Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force -ErrorAction SilentlyContinue
  }
} catch {}
function Write-LaunchLog([string]$Message) {
  try {
    # 长会话（窗口开一整天）不能让日志无限长：超过上限就轮转一次。
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath -ErrorAction SilentlyContinue).Length -gt $logMaxBytes) {
      Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force -ErrorAction SilentlyContinue
    }
    $line = "[" + (Get-Date).ToString("yyyy-MM-dd HH:mm:ss.fff") + "] " + $Message + [Environment]::NewLine
    [System.IO.File]::AppendAllText($logPath, $line, (New-Object System.Text.UTF8Encoding($false)))
  } catch {}
}

# 启动失败也要让**外面**看得见：launcher 读 status 判断窗口到底起来没有，
# 只写日志的话用户得到的是「命令返回 0，窗口没出现」。
function Write-StatusFile([string]$State, [string]$Extra = "") {
  try {
    $dir = Split-Path -Parent $StatusPath
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($StatusPath, "state=$State $Extra at=" + (Get-Date).ToString("s"), (New-Object System.Text.UTF8Encoding($false)))
  } catch {}
}

function Fail([string]$Message) {
  Write-LaunchLog "FATAL: $Message"
  Write-StatusFile "failed" ("reason=" + ($Message -replace '\s+', '_'))
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show(
      $Message + [Environment]::NewLine + [Environment]::NewLine + "日志: " + $logPath,
      "hive 隐私模式启动失败",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error)
  } catch {}
  exit 1
}

Write-LaunchLog ("hive privacy-window v$ScriptVersion")
Write-LaunchLog ("launch: workdir=$WorkDir status=$StatusPath assets=$assetDir")
Write-LaunchLog ("args: command=$Command commandArgs='$CommandArgs' cols=$Cols rows=$Rows")

if ([string]::IsNullOrWhiteSpace($Command) -or -not (Test-Path -LiteralPath $Command)) {
  Fail "找不到要运行的程序（-Command <path>，收到 '$Command'）"
}

$bridgeScript = Join-Path $assetDir "pty_bridge.py"
if (-not (Test-Path -LiteralPath $bridgeScript)) { Fail "找不到 $bridgeScript" }

$pythonExe = ""
foreach ($cand in @("python.exe", "python3.exe")) {
  $cmd = Get-Command $cand -ErrorAction SilentlyContinue
  if ($cmd) { $pythonExe = $cmd.Source; break }
}
if ([string]::IsNullOrWhiteSpace($pythonExe)) { Fail "PATH 里找不到 python.exe（需要 pywinpty）" }
Write-LaunchLog "resolved: command=$Command python=$pythonExe bridge=$bridgeScript"

# ConPTY 由 pywinpty 提供。缺了它 python 会在窗口里立刻死掉，只剩一个空白终端 ——
# 在这里先查一遍，把安装命令直接告诉用户。
try {
  & $pythonExe -c "import winpty" 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Fail ("$pythonExe 里没有 pywinpty。先装：`"$pythonExe`" -m pip install pywinpty")
  }
} catch {
  Fail ("检查 pywinpty 失败: " + $_.Exception.Message)
}

# WebView2 managed assemblies: ship them in lib\ or borrow from an existing install.
$libDir = Join-Path $assetDir "lib"
$sharedLib = Join-Path $env:USERPROFILE "tools\window-privacy\lib"
$wv2Candidates = @(
  @{ Core = "$libDir\Microsoft.Web.WebView2.Core.dll"; WinForms = "$libDir\Microsoft.Web.WebView2.WinForms.dll"; Loader = $libDir },
  @{ Core = "$sharedLib\Microsoft.Web.WebView2.Core.dll"; WinForms = "$sharedLib\Microsoft.Web.WebView2.WinForms.dll"; Loader = $sharedLib },
  @{ Core = "C:\Program Files\Listary\Microsoft.Web.WebView2.Core.dll"; WinForms = "C:\Program Files\Listary\Microsoft.Web.WebView2.WinForms.dll"; Loader = "C:\Program Files\Listary\runtimes\win-x64\native" },
  @{ Core = "C:\Program Files\Microsoft OfficePLUS\4.2.0.8924\addin\Microsoft.Web.WebView2.Core.dll"; WinForms = "C:\Program Files\Microsoft OfficePLUS\4.2.0.8924\addin\Microsoft.Web.WebView2.WinForms.dll"; Loader = "C:\Program Files\Microsoft OfficePLUS\4.2.0.8924\addin" }
)
$wv2 = $null
foreach ($c in $wv2Candidates) {
  if ((Test-Path -LiteralPath $c.Core) -and (Test-Path -LiteralPath $c.WinForms)) { $wv2 = $c; break }
}
if ($null -eq $wv2) { Fail "找不到 WebView2 托管程序集（需要 Microsoft.Web.WebView2.Core.dll / .WinForms.dll）" }
Write-LaunchLog "webview2 assemblies: $($wv2.Core)"

$udfRoot = Join-Path $env:LOCALAPPDATA "hive-privacy\webview2"
New-Item -ItemType Directory -Force -Path $udfRoot | Out-Null
$env:WEBVIEW2_USER_DATA_FOLDER = $udfRoot

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class NativePriv {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool SetDllDirectory(string lpPathName);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);
}
'@
[void][NativePriv]::SetDllDirectory($wv2.Loader)
Write-LaunchLog "webview2 loader dir: $($wv2.Loader)"

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -Path $wv2.Core
  Add-Type -Path $wv2.WinForms
} catch {
  Fail ("加载 WebView2 / WinForms 程序集失败: " + $_.Exception.Message)
}

$csharp = @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

public class PtyBridge : IDisposable
{
    Process _proc;
    volatile bool _closing;
    int _exitCode = -1;

    public int HostPid { get { try { return _proc != null ? _proc.Id : 0; } catch { return 0; } } }
    public int LastExitCode { get { return _exitCode; } }
    public Action<int> Exited;
    public Action<string> Stderr;

    public void Start(string pythonExe, string script, string exe, string args, string workDir,
                      int cols, int rows, Action<string> onLine)
    {
        var psi = new ProcessStartInfo();
        psi.FileName = pythonExe;
        psi.Arguments = "\"" + script + "\" \"" + exe + "\" \"" + workDir + "\" " + cols + " " + rows +
                        (string.IsNullOrEmpty(args) ? "" : " " + args);
        psi.UseShellExecute = false;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.CreateNoWindow = true;
        // .NET Framework 的 ProcessStartInfo 没有 StandardInputEncoding；发过去的
        // JSON 里只有 base64/数字，属 ASCII，默认编码不会破坏它。
        psi.StandardOutputEncoding = Encoding.UTF8;
        psi.StandardErrorEncoding = Encoding.UTF8;

        _proc = new Process();
        _proc.StartInfo = psi;
        _proc.EnableRaisingEvents = true;
        _proc.Exited += (s, e) =>
        {
            try { _exitCode = _proc.ExitCode; } catch { _exitCode = -1; }
            var h = Exited;
            if (!_closing && h != null) { try { h(_exitCode); } catch { } }
        };
        _proc.ErrorDataReceived += (s, e) =>
        {
            if (string.IsNullOrEmpty(e.Data)) return;
            var h = Stderr;
            if (h != null) { try { h(e.Data); } catch { } }
        };
        _proc.Start();
        _proc.BeginErrorReadLine();

        var t = new Thread(() =>
        {
            try
            {
                string line;
                while ((line = _proc.StandardOutput.ReadLine()) != null)
                {
                    if (_closing) break;
                    if (onLine != null) onLine(line);
                }
            }
            catch { }
        });
        t.IsBackground = true;
        t.Start();
    }

    public void Send(string jsonLine)
    {
        try
        {
            if (_proc == null || _proc.HasExited) return;
            _proc.StandardInput.WriteLine(jsonLine);
            _proc.StandardInput.Flush();
        }
        catch { }
    }

    /// Graceful first: closing stdin makes the bridge terminate the ConPTY child
    /// (node and its children) on its own. Only then force-kill the whole tree --
    /// a plain Kill() of the python process is what used to leave orphan node.exe.
    public void Shutdown(int graceMs)
    {
        _closing = true;
        try { if (_proc != null && !_proc.HasExited) _proc.StandardInput.Close(); } catch { }
        try { if (_proc != null && !_proc.HasExited) _proc.WaitForExit(graceMs); } catch { }
        KillTree();
    }

    void KillTree()
    {
        int pid = HostPid;
        if (pid <= 0) return;
        try
        {
            var psi = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F");
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            using (var p = Process.Start(psi)) { p.WaitForExit(3000); }
        }
        catch { }
        try { if (_proc != null && !_proc.HasExited) _proc.Kill(); } catch { }
    }

    public void Dispose()
    {
        try { Shutdown(800); } catch { }
        try { if (_proc != null) _proc.Dispose(); } catch { }
    }
}

public class PrivacyTermForm : Form
{
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
    [DllImport("user32.dll", SetLastError = true)] static extern bool GetWindowDisplayAffinity(IntPtr hWnd, out uint dwAffinity);
    [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    const uint WDA_EXCLUDEFROMCAPTURE = 0x11;
    const int WM_HOTKEY = 0x0312;
    const int WM_DISPLAYCHANGE = 0x007E;
    const int WM_SETTINGCHANGE = 0x001A;
    const int HK_TOGGLE = 1, HK_QUIT = 2, HK_RESTART = 3;
    const int WS_EX_TOOLWINDOW = 0x00000080, WS_EX_APPWINDOW = 0x00040000;

    readonly string _python, _bridgeScript, _exe, _args, _workDir, _assetDir, _udf, _statusPath, _logPath, _title;
    readonly bool _noProtect;

    WebView2 _wv;
    PtyBridge _bridge;
    System.Windows.Forms.Timer _guard;
    bool _excluded, _wasExcluded, _closing, _recovering, _childGone;
    uint _affinity;
    int _lastCols = 120, _lastRows = 34;
    int _exitCount;
    DateTime _exitWindowStart = DateTime.MinValue;
    string _state = "starting";

    public PrivacyTermForm(string python, string bridge, string exe, string args, string workDir,
                           string assetDir, string udf, string statusPath, string logPath, string title)
    {
        _python = python; _bridgeScript = bridge; _exe = exe; _args = args; _workDir = workDir;
        _assetDir = assetDir; _udf = udf; _statusPath = statusPath; _logPath = logPath; _title = title;
        // Debug only: HIVE_PRIVACY_NO_PROTECT=1（兼容旧的 REASONIX_PRIVACY_NO_PROTECT）
        // 启动时不设 WDA，方便截图排查渲染问题。
        _noProtect = Environment.GetEnvironmentVariable("HIVE_PRIVACY_NO_PROTECT") == "1"
                  || Environment.GetEnvironmentVariable("REASONIX_PRIVACY_NO_PROTECT") == "1";

        Log("form: creating window");
        AppDomain.CurrentDomain.UnhandledException += (s, e) => Log("UnhandledException: " + e.ExceptionObject);
        AppDomain.CurrentDomain.ProcessExit += (s, e) => Log("process: exit");
        Application.ThreadException += (s, e) => Log("ThreadException: " + e.Exception);

        Text = _title;
        StartPosition = FormStartPosition.CenterScreen;
        // 不出现在任务栏：工具窗口样式（见 CreateParams）+ ShowInTaskbar=false。
        // 没有任务栏按钮 / Alt+Tab 条目，靠 Ctrl+Alt+P 召唤。
        ShowInTaskbar = false;
        var wa = Screen.PrimaryScreen.WorkingArea;
        Size = new Size(Math.Min(1240, wa.Width - 80), Math.Min(820, wa.Height - 80));
        MinimumSize = new Size(640, 380);
        BackColor = Color.FromArgb(11, 11, 12);

        _wv = new WebView2();
        _wv.Dock = DockStyle.Fill;
        _wv.DefaultBackgroundColor = Color.FromArgb(11, 11, 12);
        Controls.Add(_wv);

        Shown += async (s, e) => { ApplyAffinity(true); await InitWebViewAsync(); };
        FormClosing += (s, e) => { Shutdown(); };
    }

    /// WS_EX_TOOLWINDOW 是「不进任务栏、不进 Alt+Tab」的唯一可靠开关；
    /// 只设 ShowInTaskbar 在无 owner 的无边框窗口上偶尔还会留一个空按钮。
    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TOOLWINDOW;
            cp.ExStyle &= ~WS_EX_APPWINDOW;
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        ShowWindow(Handle, 5);
        ApplyAffinity(true);
        RegisterHotKey(Handle, HK_TOGGLE, 0x0002 | 0x0001, (uint)Keys.P);
        RegisterHotKey(Handle, HK_QUIT, 0x0002 | 0x0001, (uint)Keys.Q);
        RegisterHotKey(Handle, HK_RESTART, 0x0002 | 0x0001, (uint)Keys.R);
        Log("window: handle=0x" + Handle.ToInt64().ToString("X") + " affinity=0x" + _affinity.ToString("X2") +
            " excluded=" + _excluded + " taskbar=False noProtect=" + _noProtect);
        WriteStatus("starting");

        // WDA 会被显示器切换、远程桌面、DWM 重启悄悄重置；每 3s 核一遍，
        // 失效就补上 —— 这是长会话里最常见的一种「保护静默消失」。
        _guard = new System.Windows.Forms.Timer();
        _guard.Interval = 3000;
        _guard.Tick += (s, ev) => GuardTick();
        _guard.Start();
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY)
        {
            int id = m.WParam.ToInt32();
            if (id == HK_TOGGLE)
            {
                if (Visible) { Hide(); } else { Show(); ApplyAffinity(true); Activate(); PostFocus(); }
            }
            else if (id == HK_QUIT) { Close(); }
            else if (id == HK_RESTART) { RestartChild(true); }
        }
        else if (m.Msg == WM_DISPLAYCHANGE || m.Msg == WM_SETTINGCHANGE)
        {
            // 显示器/分辨率/电源方案变化后重新上锁，并保证窗口还在可见区域内。
            ApplyAffinity(true);
            KeepOnScreen();
            WriteStatus(_state);
        }
        base.WndProc(ref m);
    }

    void ApplyAffinity(bool force)
    {
        if (_noProtect) { _affinity = 0; _excluded = false; _wasExcluded = false; return; }
        uint aff = 0;
        bool ok = GetWindowDisplayAffinity(Handle, out aff) && aff == WDA_EXCLUDEFROMCAPTURE;
        if (!ok || force)
        {
            SetWindowDisplayAffinity(Handle, WDA_EXCLUDEFROMCAPTURE);
            GetWindowDisplayAffinity(Handle, out aff);
            ok = aff == WDA_EXCLUDEFROMCAPTURE;
            if (!ok) Log("guard: WDA apply FAILED (affinity=0x" + aff.ToString("X2") + ")");
            else if (!force) Log("guard: WDA restored");
        }
        _affinity = aff;
        _excluded = ok;
        _wasExcluded = ok;
    }

    void GuardTick()
    {
        try
        {
            if (_closing || IsDisposed) return;
            if (!_noProtect)
            {
                uint aff;
                bool ok = GetWindowDisplayAffinity(Handle, out aff) && aff == WDA_EXCLUDEFROMCAPTURE;
                if (!ok && _wasExcluded)
                {
                    Log("guard: WDA dropped (affinity=0x" + aff.ToString("X2") + "), re-applying");
                    PostOutputText("\u001b[33m[privacy] 防录屏保护被系统重置，正在恢复…\u001b[0m\r\n");
                }
                ApplyAffinity(false);
            }
            WriteStatus(_state);
        }
        catch { }
    }

    void KeepOnScreen()
    {
        try
        {
            var wa = Screen.FromControl(this).WorkingArea;
            int x = Math.Min(Math.Max(Left, wa.Left), Math.Max(wa.Left, wa.Right - Width));
            int y = Math.Min(Math.Max(Top, wa.Top), Math.Max(wa.Top, wa.Bottom - Height));
            if (x != Left || y != Top) { Left = x; Top = y; }
        }
        catch { }
    }

    async System.Threading.Tasks.Task InitWebViewAsync()
    {
        // The user-data folder can be locked by a leftover msedgewebview2 process from a
        // previous run; fall back through the default folder and a temp folder instead of
        // dying with a window that appears and vanishes.
        string[] udfs = new string[]
        {
            _udf,
            null,
            Path.Combine(Path.GetTempPath(), "hive-privacy-webview2")
        };

        Exception last = null;
        foreach (var udf in udfs)
        {
            try
            {
                Log("webview: CreateAsync udf=" + (udf == null ? "<default>" : udf));
                var env = await CoreWebView2Environment.CreateAsync(null, udf, null);
                await _wv.EnsureCoreWebView2Async(env);
                last = null;
                Log("webview: ready udf=" + (udf == null ? "<default>" : udf));
                break;
            }
            catch (Exception ex)
            {
                last = ex;
                Log("webview: CreateAsync failed udf=" + (udf == null ? "<default>" : udf) + " -> " + ex);
            }
        }

        if (last != null) { ShowFatal("WebView2 初始化失败", last); return; }

        try
        {
            var core = _wv.CoreWebView2;
            core.SetVirtualHostNameToFolderMapping("privacy.local", _assetDir, CoreWebView2HostResourceAccessKind.Allow);
            core.WebMessageReceived += OnWebMessage;
            core.ProcessFailed += (s, e) =>
            {
                Log("webview: process failed kind=" + e.ProcessFailedKind);
                try { BeginInvoke(new Action(RecoverWebView)); } catch { }
            };
            core.NavigationCompleted += async (s, e) =>
            {
                Log("webview: navigation completed ok=" + e.IsSuccess + " status=" + e.WebErrorStatus);
                if (!e.IsSuccess) return;
                try
                {
                    var bar = await core.ExecuteScriptAsync("document.getElementById('bar') ? document.getElementById('bar').innerText : '<no bar>'");
                    Log("webview: probe bar=" + bar);
                }
                catch (Exception ex)
                {
                    Log("webview: probe failed " + ex.Message);
                }
            };
            core.Navigate("https://privacy.local/terminal.html");
            _state = "webview-ready";
            WriteStatus(_state);
            Log("webview: navigated to https://privacy.local/terminal.html");
        }
        catch (Exception ex)
        {
            ShowFatal("加载终端页面失败", ex);
        }
    }

    /// WebView2 的渲染进程会自己崩溃（内存压力、GPU 驱动）。以前的表现是白屏，
    /// 只能关掉整个窗口；现在重建控件并重开终端。
    async void RecoverWebView()
    {
        if (_recovering || _closing || IsDisposed) return;
        _recovering = true;
        try
        {
            Log("webview: recovering after process failure");
            DisposeBridge();
            PostJson("{\"type\":\"status\",\"text\":\"renderer crashed, reloading\"}");
            try { Controls.Remove(_wv); _wv.Dispose(); } catch { }
            _wv = new WebView2();
            _wv.Dock = DockStyle.Fill;
            _wv.DefaultBackgroundColor = Color.FromArgb(11, 11, 12);
            Controls.Add(_wv);
            _wv.BringToFront();
            await InitWebViewAsync();
        }
        catch (Exception ex) { Log("webview: recover failed " + ex); }
        finally { _recovering = false; }
    }

    void Log(string msg)
    {
        try
        {
            var fi = new FileInfo(_logPath);
            if (fi.Exists && fi.Length > 4 * 1024 * 1024)
            {
                try { File.Copy(_logPath, _logPath + ".1", true); } catch { }
                try { File.WriteAllText(_logPath, ""); } catch { }
            }
            File.AppendAllText(_logPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "] " + msg + "\r\n");
        }
        catch { }
    }

    /// Keep the window on screen with the reason: a silent Close() is what makes this look
    /// like "the window flashes and disappears".
    void ShowFatal(string what, Exception ex)
    {
        Log("FATAL " + what + "\r\n" + (ex != null ? ex.ToString() : ""));
        _state = "failed";
        WriteStatus("failed");
        try
        {
            Text = _title + " (启动失败)";
            Controls.Remove(_wv);
            try { _wv.Dispose(); } catch { }
            var box = new Label();
            box.Dock = DockStyle.Fill;
            box.Padding = new Padding(16);
            box.BackColor = Color.FromArgb(11, 11, 12);
            box.ForeColor = Color.FromArgb(240, 130, 130);
            box.Font = new Font("Consolas", 10f);
            box.Text = what + "\r\n\r\n" + (ex != null ? ex.Message : "") + "\r\n\r\n完整日志: " + _logPath;
            Controls.Add(box);
            Show();
            Activate();
        }
        catch { }
    }

    void PostFocus()
    {
        try { if (_wv.CoreWebView2 != null) _wv.CoreWebView2.PostWebMessageAsString("{\"type\":\"focus\"}"); } catch { }
    }

    void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string json;
        try { json = e.TryGetWebMessageAsString(); } catch { return; }
        if (json == null) return;

        var mt = Regex.Match(json, "\"type\"\\s*:\\s*\"([a-z]+)\"");
        if (!mt.Success) return;
        string type = mt.Groups[1].Value;

        if (type == "ready")
        {
            int cols = ParseInt(json, "cols", _lastCols);
            int rows = ParseInt(json, "rows", _lastRows);
            _lastCols = cols; _lastRows = rows;
            StartChild(cols, rows);
            return;
        }

        if (type == "resize")
        {
            int cols = ParseInt(json, "cols", _lastCols);
            int rows = ParseInt(json, "rows", _lastRows);
            _lastCols = cols; _lastRows = rows;
            if (_bridge != null) _bridge.Send("{\"t\":\"size\",\"cols\":" + cols + ",\"rows\":" + rows + "}");
            return;
        }

        if (type == "input" && _bridge != null)
        {
            var md = Regex.Match(json, "\"data\"\\s*:\\s*\"([^\"]*)\"");
            if (!md.Success) return;
            _bridge.Send("{\"t\":\"in\",\"d\":\"" + md.Groups[1].Value + "\"}");
        }
    }

    static int ParseInt(string json, string key, int def)
    {
        var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(-?\\d+)");
        if (!m.Success) return def;
        long v;
        if (!long.TryParse(m.Groups[1].Value, out v)) return def;
        // pywinpty 的 exitstatus 可能是 4294967295（0xFFFFFFFF = 进程被强杀），
        // 转成 int 就是 -1，正好落在「非正常退出」分支。
        return unchecked((int)v);
    }

    void StartChild(int cols, int rows)
    {
        if (_bridge != null || _closing) return;
        try
        {
            Log("bridge: starting python=" + _python + " cols=" + cols + " rows=" + rows);
            var b = new PtyBridge();
            b.Exited = (code) => { try { BeginInvoke(new Action(() => OnChildExited(code))); } catch { } };
            b.Stderr = (line) => { Log("bridge stderr: " + line); };
            b.Start(_python, _bridgeScript, _exe, _args, _workDir, cols, rows, OnBridgeLine);
            _bridge = b;
            _childGone = false;
            _state = "running";
            WriteStatus(_state);
            Log("bridge: host pid=" + b.HostPid);
        }
        catch (Exception ex)
        {
            Log("bridge: start failed -> " + ex);
            _state = "failed";
            WriteStatus(_state);
            PostOutputText("\u001b[31m[privacy] bridge failed: " + ex.Message + "\u001b[0m\r\n");
        }
    }

    /// 两条路都会到这里：bridge 自己报的 {"t":"exit","code":N}（node 死了但 python
    /// 还活着），以及 python 退出时的 Process.Exited。用 _childGone 去重，只处理一次。
    void OnChildExited(int code)
    {
        if (_closing || IsDisposed || _childGone) return;
        _childGone = true;
        Log("bridge: child exited code=" + code);
        DisposeBridge();
        _state = "child-exited";
        WriteStatus(_state);

        var now = DateTime.UtcNow;
        if ((now - _exitWindowStart).TotalSeconds > 120) { _exitWindowStart = now; _exitCount = 0; }

        if (code == 0)
        {
            // 用户自己退出（/quit、Ctrl+C）：不自动重启，否则就退不出去了。
            PostOutputText("\r\n\u001b[33m[privacy] 终端进程已退出。Ctrl+Alt+R 重新启动 / Ctrl+Alt+Q 关闭窗口。\u001b[0m\r\n");
            return;
        }

        _exitCount++;
        if (_exitCount > 3)
        {
            PostOutputText("\r\n\u001b[31m[privacy] 终端进程连续异常退出 3 次，已停止自动重启。" +
                           "按 Ctrl+Alt+R 手动重启；日志：" + _logPath + "\u001b[0m\r\n");
            return;
        }
        int delay = new int[] { 800, 2500, 6000 }[Math.Min(_exitCount - 1, 2)];
        PostOutputText("\r\n\u001b[33m[privacy] 终端进程异常退出（code " + code + "），" +
                       (delay / 1000.0).ToString("0.0") + "s 后自动重启…\u001b[0m\r\n");
        var t = new System.Windows.Forms.Timer();
        t.Interval = delay;
        t.Tick += (s, e) => { t.Stop(); t.Dispose(); RestartChild(false); };
        t.Start();
    }

    void RestartChild(bool manual)
    {
        if (_closing || IsDisposed) return;
        if (_bridge != null && !manual && _bridge.HostPid > 0) return;
        if (manual) Log("bridge: manual restart requested");
        DisposeBridge();
        PostOutputText("\u001b[0m\u001b[2J\u001b[H");
        StartChild(_lastCols, _lastRows);
    }

    void DisposeBridge()
    {
        var b = _bridge;
        _bridge = null;
        if (b == null) return;
        try { b.Shutdown(1200); } catch { }
        try { b.Dispose(); } catch { }
    }

    void OnBridgeLine(string line)
    {
        try { BeginInvoke(new Action(() => HandleBridgeLine(line))); } catch { }
    }

    void HandleBridgeLine(string json)
    {
        var mt = Regex.Match(json, "\"t\"\\s*:\\s*\"([a-z]+)\"");
        if (!mt.Success) return;
        string type = mt.Groups[1].Value;

        if (type == "out")
        {
            var md = Regex.Match(json, "\"d\"\\s*:\\s*\"([^\"]*)\"");
            if (md.Success) PostJson("{\"type\":\"output\",\"b64\":\"" + md.Groups[1].Value + "\"}");
            return;
        }
        if (type == "exit")
        {
            // node 死了，但 python 还活着（它继续等 stdin），所以 Process.Exited
            // 不会来 —— 必须在这里进重启判断，否则窗口就停在死终端上。
            OnChildExited(ParseInt(json, "code", -1));
            return;
        }
        if (type == "err")
        {
            var me = Regex.Match(json, "\"m\"\\s*:\\s*\"([^\"]*)\"");
            if (me.Success) PostOutputText("\u001b[31m[privacy] " + me.Groups[1].Value + "\u001b[0m\r\n");
        }
    }

    void PostOutputText(string text)
    {
        byte[] b = Encoding.UTF8.GetBytes(text);
        PostJson("{\"type\":\"output\",\"b64\":\"" + Convert.ToBase64String(b) + "\"}");
    }

    void PostJson(string json)
    {
        try { if (_wv != null && _wv.CoreWebView2 != null) _wv.CoreWebView2.PostWebMessageAsString(json); } catch { }
    }

    void WriteStatus(string state)
    {
        _state = state;
        try
        {
            string pid = _bridge != null ? _bridge.HostPid.ToString() : "0";
            File.WriteAllText(_statusPath,
                "state=" + state +
                " excluded=" + _excluded +
                " affinity=0x" + _affinity.ToString("X2") +
                " host_pid=" + pid +
                " win_pid=" + Process.GetCurrentProcess().Id +
                " hwnd=0x" + Handle.ToInt64().ToString("X") +
                " at=" + DateTime.Now.ToString("s"));
        }
        catch { }
    }

    void Shutdown()
    {
        _closing = true;
        try { if (_guard != null) { _guard.Stop(); _guard.Dispose(); } } catch { }
        DisposeBridge();
        Log("form: closing, child stopped");
        WriteStatus("closed");
    }
}
'@

try {
  Add-Type -TypeDefinition $csharp -ReferencedAssemblies @(
    "System.Windows.Forms",
    "System.Drawing",
    "System.Core",
    "System",
    $wv2.Core,
    $wv2.WinForms
  )
} catch {
  Fail ("编译窗口代码失败: " + $_.Exception.Message)
}
Write-LaunchLog "csharp: compiled"

# One window per session: a second instance would steal the global hotkeys from the first,
# so instead of opening another window we bring the existing one back. The taskbar no
# longer offers a way back to a hidden window, so this path matters more than before.
$mutex = New-Object System.Threading.Mutex($false, "Global\hive-privacy-window")
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) {
  Write-LaunchLog "another instance is already running; activating its window"
  try {
    Add-Type -Namespace NativeWin -Name Finder -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
'@ | Out-Null
    # PowerShell turns $null into "" for string parameters, and FindWindow("") never
    # matches - it must be a real NULL pointer, hence NullString::Value.
    $nullName = [System.Management.Automation.Language.NullString]::Value
    $h = [IntPtr]::Zero

    # First choice: the handle the running window wrote to window.status. Titles can
    # change ("(启动失败)"), handles cannot.
    try {
      if (Test-Path -LiteralPath $StatusPath) {
        $raw = Get-Content -LiteralPath $StatusPath -Raw -ErrorAction SilentlyContinue
        $m = [regex]::Match([string]$raw, 'hwnd=0x([0-9A-Fa-f]+)')
        if ($m.Success) {
          $cand = [IntPtr][Convert]::ToInt64($m.Groups[1].Value, 16)
          if ([NativeWin.Finder]::IsWindow($cand)) { $h = $cand }
        }
      }
    } catch { }

    if ($h -eq [IntPtr]::Zero) { $h = [NativeWin.Finder]::FindWindow($nullName, $Title) }
    if ($h -eq [IntPtr]::Zero) { $h = [NativeWin.Finder]::FindWindow($nullName, ($Title + " (启动失败)")) }
    if ($h -ne [IntPtr]::Zero) {
      [void][NativeWin.Finder]::ShowWindow($h, 5)   # SW_SHOW（可能被 Ctrl+Alt+P 藏起来了）
      [void][NativeWin.Finder]::ShowWindow($h, 9)   # SW_RESTORE
      [void][NativeWin.Finder]::SetForegroundWindow($h)
      Write-LaunchLog "activated existing window"
      Write-StatusFile "running" "note=activated-existing"
    } else {
      Write-LaunchLog "existing instance found but its window is gone; leaving it alone"
      Write-StatusFile "failed" "reason=previous-instance-has-no-window"
      exit 1
    }
  } catch {
    Write-LaunchLog ("activate failed: " + $_.Exception.Message)
    Write-StatusFile "failed" ("reason=" + ($_.Exception.Message -replace '\s+', '_'))
    exit 1
  }
  exit 0
}

[System.Windows.Forms.Application]::EnableVisualStyles()
try {
  $form = New-Object PrivacyTermForm($pythonExe, $bridgeScript, $Command, $CommandArgs.Trim(), $WorkDir, $assetDir, $udfRoot, $StatusPath, $logPath, $Title)
  Write-LaunchLog "form: constructed, entering message loop"
  [System.Windows.Forms.Application]::Run($form)
  Write-LaunchLog "form: message loop exited"
} catch {
  Write-LaunchLog ("FATAL message loop: " + $_.Exception.ToString())
  Fail ("隐私窗口异常退出: " + $_.Exception.Message)
} finally {
  try { if ($owned) { $mutex.ReleaseMutex() } } catch {}
}
