#!/usr/bin/env python3
"""伪终端桥：给需要真终端的交互程序（如 cursor-agent 的 /usage 界面）用。

用法：python3 pty-bridge.py <行数> <列数> <程序> [参数...]
把自己的标准输入原样写给程序，把程序在终端里的输出原样写到标准输出。
macOS 自带的 script 要求标准输入本身是终端，被 Node 用管道起动时会直接报错退出，所以不用它。
收到 SIGTERM 或标准输入被关闭时，先给整个程序组发 SIGTERM、等它自己退出，最多等 GRACE 秒，
还没退干净就整组 SIGKILL，不留残余进程。
先礼后兵的原因（2026-09-30 实测 cursor-agent 2026.09.28）：它启动时在安装目录的 .running/ 下按进程号
写空文件（主进程和它起的子进程各一个），只在正常退出时删；直接 SIGKILL 来不及删，每查一次额度留两个。
整组 SIGTERM 时两个进程都自己删掉标记，0.02 秒内退出。"""
import fcntl, os, pty, select, signal, struct, sys, termios, time

GRACE = 1.5  # 调用方（quota.ts）给桥的收尾时间要比这个长。
rows, cols, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    # 在程序启动前设好窗口大小，否则它按 0x0 排版，界面会错乱。
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    os.execvp(argv[0], argv)


def signal_group(sig):
    try:
        os.killpg(pid, sig)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # macOS：组里只剩还没被收走的已退出进程时报 EPERM，当作已经退干净。
        return False


stopping = False


def stop(*_):
    global stopping
    if stopping:
        return
    stopping = True
    reaped = False
    if signal_group(signal.SIGTERM):
        deadline = time.monotonic() + GRACE
        while time.monotonic() < deadline:
            # 退出时的输出照读照扔，免得终端缓冲写满把它卡住。
            try:
                if select.select([fd], [], [], 0.05)[0]:
                    os.read(fd, 65536)
            except OSError:
                time.sleep(0.05)
            if not reaped:
                try:
                    reaped = os.waitpid(pid, os.WNOHANG)[0] != 0
                except ChildProcessError:
                    reaped = True
            if reaped and not signal_group(0):
                break
    signal_group(signal.SIGKILL)
    if not reaped:
        try:
            os.waitpid(pid, 0)
        except OSError:
            pass
    os._exit(0)


signal.signal(signal.SIGTERM, stop)
watch = [fd, 0]
while True:
    ready, _, _ = select.select(watch, [], [])
    if 0 in ready:
        data = os.read(0, 65536)
        if not data:
            stop()
        os.write(fd, data)
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if not data:
            break
        os.write(1, data)
stop()
