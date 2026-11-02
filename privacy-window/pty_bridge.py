"""pty_bridge.py - host a TUI program in a ConPTY and speak JSON lines.

Why: SetWindowDisplayAffinity only works inside the process that owns the window, so
the privacy window must own both the UI and the terminal. pywinpty handles the
ConPTY plumbing reliably from Python; the C# window drives it over stdin/stdout.

Protocol (one JSON object per line, UTF-8):
  out  : {"t":"out","d":"<base64 utf-8>"}   terminal bytes from the child
  exit : {"t":"exit","code":<int|null>}     child gone (code tells crash from /quit)
  err  : {"t":"err","m":"..."}
  in   : {"t":"in","d":"<base64 utf-8>"}    keystrokes to send
  size : {"t":"size","cols":120,"rows":34}  terminal resize
  quit : {"t":"quit"}

Usage: python pty_bridge.py <exe> <cwd> <cols> <rows> [args...]
"""

import base64
import ctypes
import json
import os
import sys
import threading
import time

from winpty import PtyProcess

# 窗口里出问题时（spawn 失败、子进程秒退）终端上看不到，落一份日志。
LOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pty-bridge.log")
LOG_MAX_BYTES = 512 * 1024


def log(msg: str) -> None:
    try:
        # 一个窗口可能开一整天，append 不设上限会把日志撑到几十 MB。
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > LOG_MAX_BYTES:
            try:
                os.replace(LOG_PATH, LOG_PATH + ".1")
            except OSError:
                pass
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg))
    except Exception:
        pass


def quote(arg: str) -> str:
    """Windows command-line quoting: paths such as 'C:\\Program Files\\nodejs\\node.exe'
    must survive CreateProcess intact."""
    if not arg:
        return '""'
    if any(ch in arg for ch in ' \t"'):
        return '"' + arg.replace('"', '\\"') + '"'
    return arg


def parent_alive(ppid: int) -> bool:
    """父进程死了没有。

    窗口进程被强杀时，stdin 管道不一定 EOF（句柄被 conhost/node 继承），
    只靠 `for raw in sys.stdin.buffer` 会让这个 bridge 变成孤儿，继续占着
    ConPTY 和 node 子进程。Windows 的 os.getppid() 不会因为父进程死亡而变，
    所以用句柄 + WaitForSingleObject(0) 直接问内核。
    """
    if ppid <= 0:
        return False
    SYNCHRONIZE = 0x00100000
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, False, int(ppid))
    if not handle:
        return False
    try:
        WAIT_TIMEOUT = 0x00000102
        return kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
    finally:
        kernel32.CloseHandle(handle)


def main() -> int:
    if len(sys.argv) < 5:
        sys.stderr.write("usage: pty_bridge.py <exe> <cwd> <cols> <rows> [args...]\n")
        return 2

    exe = sys.argv[1]
    cwd = sys.argv[2]
    extra = sys.argv[5:]
    try:
        cols = int(sys.argv[3])
        rows = int(sys.argv[4])
    except ValueError:
        cols, rows = 120, 34
    cols = max(20, min(cols, 500))
    rows = max(5, min(rows, 200))

    cmd = " ".join([quote(exe)] + [quote(a) for a in extra])
    log("spawn: %s (cwd=%s, %dx%d)" % (cmd, cwd, cols, rows))

    out = sys.stdout.buffer
    lock = threading.Lock()

    def emit(obj):
        payload = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        with lock:
            try:
                out.write(payload)
                out.flush()
            except Exception:
                pass

    if not os.path.exists(exe):
        log("spawn failed: exe not found: %s" % exe)
        emit({"t": "err", "m": "找不到终端程序: %s" % exe})
        return 1

    try:
        proc = PtyProcess.spawn(cmd, dimensions=(rows, cols), cwd=cwd)
    except Exception as exc:
        log("spawn failed: %s" % exc)
        emit({"t": "err", "m": "spawn failed: %s" % exc})
        return 1
    log("spawned pid=%s" % getattr(proc, "pid", "?"))

    def pump():
        while True:
            try:
                data = proc.read(8192)
            except EOFError:
                log("child eof")
                break
            except Exception as exc:
                log("read error: %s" % exc)
                emit({"t": "err", "m": "read: %s" % exc})
                break
            if not data:
                log("child produced no data")
                break
            try:
                encoded = base64.b64encode(data.encode("utf-8", "replace")).decode("ascii")
            except Exception:
                continue
            emit({"t": "out", "d": encoded})

        # 退出码决定窗口要不要自动重启：0 = 用户自己退出（/quit），非 0 = 崩了。
        code = None
        try:
            proc.wait()
            code = proc.exitstatus
        except Exception:
            try:
                code = proc.exitstatus
            except Exception:
                code = None
        log("pump finished (code=%r)" % (code,))
        emit({"t": "exit", "code": code})

    threading.Thread(target=pump, daemon=True).start()

    # 窗口进程被强杀时不能把自己留成孤儿：父进程一没，就把 ConPTY 子进程收掉退出。
    ppid = os.getppid()

    def watch_parent():
        while True:
            time.sleep(2.0)
            try:
                alive = parent_alive(ppid)
            except Exception:
                alive = True
            if not alive:
                log("parent %d is gone; terminating child" % ppid)
                try:
                    proc.terminate(force=True)
                except Exception:
                    pass
                os._exit(0)

    threading.Thread(target=watch_parent, daemon=True).start()

    for raw in sys.stdin.buffer:
        try:
            msg = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            continue
        kind = msg.get("t")
        try:
            if kind == "in":
                data = base64.b64decode(msg.get("d", ""))
                proc.write(data.decode("utf-8", "replace"))
            elif kind == "size":
                proc.setwinsize(int(msg.get("rows", rows)), int(msg.get("cols", cols)))
            elif kind == "quit":
                break
        except Exception as exc:
            emit({"t": "err", "m": "%s: %s" % (kind, exc)})

    # stdin 关了（窗口关闭 / 窗口进程退出）：先把子进程优雅收掉，再兜底强杀。
    # 以前直接 Kill python 进程，node 会变成孤儿留在后台。
    log("shutting down child")
    try:
        if getattr(proc, "isalive", lambda: False)():
            proc.terminate(force=False)
            for _ in range(20):
                if not proc.isalive():
                    break
                time.sleep(0.05)
            if proc.isalive():
                proc.terminate(force=True)
    except Exception as exc:
        log("terminate failed: %s" % exc)
        try:
            proc.terminate(force=True)
        except Exception:
            pass
    log("bridge exit")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
