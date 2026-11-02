# hive 隐私模式设计 —— 只有物理屏幕能看到对话

## 0. v4.5：默认把完整终端搬进窗口

```
hive（正常进程）
  └─ 启动菜单：1 正常终端 / 2 隐私窗口（必须选，回车不算数）
       └─ 选 2：写 .hive/privacy/window.json
            └─ WMI Win32_Process.Create → powershell -File privacy-window\window.ps1 -Spec <json>
               （起不来才退回 cmd /c start）
                 └─ WinForms 工具窗口（无任务栏 / 无 Alt+Tab）
                      + SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
                      └─ WebView2 + xterm.js
                           ↕ ConPTY（pty_bridge.py）
                      node dist/cli.js --privacy-child
```

- 窗口里跑的是**真正的 hive 终端**：斜杠命令、工具调用输出、流式回复、模型切换都在。
- `--privacy-child` 有两个作用：跳过启动菜单（否则窗口里会再问一次），以及让账本把
  正文列写成 `[privacy]`（`src/repl.ts`）。
- 启动参数走 `<privacy dir>/window.json`：powershell → C# → python 三段拼接里，含空格的
  路径很容易被拆坏，写文件最稳。
- 热键：`Ctrl+Alt+P` 显示/隐藏，`Ctrl+Alt+R` 重启终端，`Ctrl+Alt+Q` 退出；单实例互斥体
  `Global\hive-privacy-window`，重复启动会按 `window.status` 里的 hwnd 恢复并前置已有窗口。
- 排错：`privacy-window/privacy-launch.log`（窗口侧每一步）与
  `privacy-window/pty-bridge.log`（spawn 命令、子进程 pid、子进程退出）。
  `HIVE_PRIVACY_NO_PROTECT=1` 可关掉 WDA，用于排查渲染。

### 0.1 后台进程：不进任务栏，也不挂在启动它的终端下面

- **窗口是工具窗口**：`CreateParams` 里加 `WS_EX_TOOLWINDOW`、去掉 `WS_EX_APPWINDOW`，
  再加 `ShowInTaskbar = false`。任务栏和 Alt+Tab 里都没有它 —— 实测 exstyle
  `0x00010180`（`tool=True app=False`）。召唤只能靠 `Ctrl+Alt+P`，这是隐私模式该有的样子。
- **窗口进程由 WMI 创建**（`Win32_Process.Create`），父进程是 WmiPrvSE 而不是启动器。
  `spawn(..., { detached: true })` 在 Windows 上只表示「新进程组」，子进程仍在父进程的
  Job Object 里，宿主退出时若 job 带 `KILL_ON_JOB_CLOSE` 会被一起带走（实测：启动器一退出，
  窗口就没了）。走 WMI 之后关掉终端窗口，窗口照样在跑。
- **启动器要能看见结果**：启动后轮询 `window.status`（最长 15s），只有 `webview-ready` /
  `running` / `child-exited` 才算起来；`failed` 立刻返回原因 + 日志路径。非 0 退出码表示
  窗口没开起来，不再是「命令返回 0、窗口不见」。

### 0.2 稳定性：坏了要能自己回来

| 故障 | 以前 | 现在 |
|---|---|---|
| WDA 被显示器切换 / DWM 重启 / 远程桌面重置 | 静默失效，录屏里又能看见 | 每 3s 校验 `GetWindowDisplayAffinity`，掉了就重设；`WM_DISPLAYCHANGE` / `WM_SETTINGCHANGE` 也补一次，并在终端里提示 |
| 窗口里的 node 崩了 | 停在死终端，只能关窗重开 | bridge 报 `{"t":"exit","code":N}`；非 0 退出按 800ms/2.5s/6s 退避自动重启（2 分钟内最多 3 次），0 退出视为用户主动退出不重启 |
| WebView2 渲染进程崩溃 | 白屏 | `ProcessFailed` → 销毁控件重建 + 重开终端 |
| 关窗 / Ctrl+Alt+Q | 只 Kill python，node 变孤儿 | 先关 stdin 让 bridge 优雅 `terminate` ConPTY，再 `taskkill /T /F` 兜底 |
| 窗口进程被强杀 | python bridge 变孤儿（管道句柄被 conhost/node 继承，读不到 EOF） | bridge 每 2s 用 `WaitForSingleObject(0)` 查父进程，父没了就自己收掉子进程退出 |
| 缺 pywinpty | 窗口里一个空白终端 | 启动前 `python -c "import winpty"` 预检，弹框直接给 `pip install pywinpty` |
| 日志无限增长 | 长会话能撑到几十 MB | 窗口侧 4MB、bridge 侧 512KB 轮转 |

下面 1~5 节描述的是 **classic** 路径（`hive privacy --classic`）：文件桥接 + 自绘聊天窗，
保留给排查和不支持 ConPTY 的场景。

---

> 一句话：`hive privacy` 把对话搬进一个自己创建的窗口，并对它调用
> `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`；终端只显示状态，
> OBS / 录屏软件 / 腾讯会议共享看不到聊天内容。

## 0. 为什么不能直接保护终端窗口

`SetWindowDisplayAffinity` 的文档与实测都表明：**只能作用于调用进程自己拥有的窗口**。
对 Windows Terminal 的窗口从外部调用会返回 `FALSE`（实测 `hide=False`，`aff=0x00`）。

```
powershell -> 找 WindowsTerminal 的 HWND -> SetWindowDisplayAffinity -> FALSE
```

DLL 注入可以绕过这条限制，但它会碰到安全软件、签名与稳定性问题，hive 不做。

因此唯一干净的路径是：**承载敏感内容的窗口由我们自己的进程创建**。终端只作为
启动器与状态面板。

## 1. 形态

```
hive privacy
   ├─ 写 .hive/privacy/bridge.ps1（内嵌脚本，WDA 自设）
   ├─ 启动 PowerShell WinForms 窗口（detached）
   ├─ 终端只打印「隐私模式 · 窗口已打开」
   └─ 轮询 inbox → agent.run() → 追加 transcript → 窗口刷新
```

窗口与 hive 之间不共享内存，只用四个文件（都在 `.hive/privacy/`）：

| 文件 | 方向 | 内容 |
|---|---|---|
| `transcript.txt` | hive → 窗口 | 完整对话（`[you]` / `[ai]` / `[error]` 段落） |
| `inbox.txt` | 窗口 → hive | 用户刚提交的一条问题 |
| `inbox.seq` | 窗口 → hive | 单调递增序号（避免重复处理同一条） |
| `closed.flag` | 窗口 → hive | 窗口关闭时写入，hive 据此退出 |

轮询间隔 250ms；本地文件 IO 的延迟远小于一次模型往返。

## 2. 窗口

- WinForms 无边框、置顶、深色；只读对话区 + 多行输入框。
- `OnHandleCreated`：`ShowWindow(SW_SHOW)` → `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`。
  `SW_SHOW` 是必要的：以 `-WindowStyle Hidden` 启动时，STARTUPINFO 的
  `SW_HIDE` 会被窗口的第一次显示继承，不覆盖就会「进程活着但窗口不可见」。
- 热键 `Ctrl+Alt+P` 显示 / 隐藏；`Ctrl+Enter` 发送；`Esc` 隐藏。
- 状态写入 `.hive/privacy/window.status`（`excluded=True affinity=0x11`），便于自检。

## 3. 隐私边界

保证的：

- 对话文本只写进 `.hive/privacy/transcript.txt` 与窗口；**不写 stdout**。
- 账本照常记 token，但 `userHead` / `outHead` 写占位符（`[privacy]` / 空），
  不把内容带进 `costs.db`。
- `.hive/privacy/` 进 `.gitignore`，不会被误提交。
- 窗口对 DXGI Desktop Duplication / Windows Graphics Capture /
  大多数共享屏幕工具不可见（这是 WDA 的定义行为）。

不保证的：

- 手机拍摄、HDMI 采集卡、虚拟机宿主机的截屏。
- 以「窗口捕获」方式显式选中该窗口的工具：WDA 会让它显示为黑框，但不同
  版本的工具行为可能不一致，需要实测。
- 终端的启动状态行（不含对话）仍然可见。
- 非 Windows 平台：`hive privacy` 直接拒绝（WDA 是 Win32 API）。

## 4. 与 cache / 性能的关系

- 不改工具 schema、不改 system 前缀 —— 缓存不受影响。
- 每轮仍是一次 `agent.run()`；文件轮询不进入模型上下文。
- 与 `ask_parent` / `delegate` 兼容：窗口只是换了一个输入输出端。

## 5. 零 API 测试

1. `privacyPaths` 的路径都在 `.hive/privacy/` 下
2. `readInbox`：缺文件返回 null；seq 解析失败返回 null；正常返回文本
3. `appendTranscript`：追加不覆盖；包含 `[you]` / `[ai]` 标记
4. `windowClosed`：flag 存在为真
5. `resetPrivacySession`：清掉四个文件，但保留目录
6. `privacySupported('linux') === false`
7. 内嵌脚本包含 `WDA_EXCLUDEFROMCAPTURE`、`ShowWindow`、`inbox.seq`、`closed.flag`
8. `writeBridgeScript` 落盘内容与常量一致

真机验收（Windows）：
`hive privacy` → 窗口出现 → 输入一句 → 回复只出现在窗口 → 用 OBS 显示器捕获
确认窗口区域被排除 → 关窗口后 hive 退出。
