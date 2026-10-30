#!/usr/bin/python3
"""Own a sidecar's descendants without changing the shared workspace trust domain."""

import ctypes
import os
import select
import signal
import subprocess
import sys
import time


def identity(pid):
    """Open before inspecting /proc: signaling cannot hit a recycled numeric PID."""
    return os.pidfd_open(pid)


def send(fd, sig):
    try:
        signal.pidfd_send_signal(fd, sig)
    except ProcessLookupError:
        pass


def supervise(argv):
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), "cannot establish child subreaper")
    # Refuse to launch work on a kernel/Python without safe process handles.
    os.close(identity(os.getpid()))
    cancelled = False

    def stop(_sig, _frame):
        nonlocal cancelled
        cancelled = True

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    # Popen otherwise replaces inherited stdin with /dev/null in some wrappers;
    # explicit fd 0 also preserves Docker's half-close/StartRunRequest protocol.
    child = subprocess.Popen(argv, stdin=0)
    status = None
    while True:
        # Reap every adopted orphan, retaining the actual sidecar's exit status.
        while True:
            try:
                pid, code = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return (128 + signal.SIGTERM) if cancelled else (status or 0)
            if pid == 0:
                break
            if pid == child.pid:
                status = os.waitstatus_to_exitcode(code)
                if status < 0:
                    status = 128 - status
        if cancelled or status is not None:
            # Killing parents first reparents grandchildren to this subreaper.
            # Repeat until waitpid reports ECHILD; no ancestry snapshot can miss
            # a double fork, nested subreaper, setsid, or an environment reset.
            with open(f"/proc/self/task/{os.getpid()}/children") as stream:
                children = stream.read().split()
            for pid in children:
                try:
                    fd = identity(int(pid))
                except ProcessLookupError:
                    continue
                try:
                    send(fd, signal.SIGKILL)
                finally:
                    os.close(fd)
        time.sleep(0.01)


def terminate(key, value):
    marker = os.fsencode(f"{key}={value}")
    supervisors = []
    legacy = []
    me = os.getpid()
    for entry in os.listdir("/proc"):
        if not entry.isdecimal() or int(entry) == me:
            continue
        fd = None
        try:
            fd = identity(int(entry))
            with open(f"/proc/{entry}/environ", "rb") as stream:
                marked = marker in stream.read().split(b"\0")
            if not marked:
                continue
            with open(f"/proc/{entry}/cmdline", "rb") as stream:
                command = stream.read().split(b"\0")
            if len(command) >= 3 and command[1:3] == [os.fsencode(__file__), b"run"]:
                supervisors.append(fd)
            else:
                legacy.append(fd)
            fd = None
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            pass
        finally:
            if fd is not None:
                os.close(fd)
    try:
        for fd in supervisors:
            send(fd, signal.SIGTERM)
        deadline = time.monotonic() + 8
        for fd in supervisors:
            remaining = max(0, deadline - time.monotonic())
            if not select.select([fd], [], [], remaining)[0]:
                raise TimeoutError("run descendant cleanup not confirmed; supervisor retained")
        # Compatibility for non-run execs/old sidecars. pidfds opened before the
        # supervisor drain cannot signal a new process that reuses a child's PID.
        for fd in legacy:
            send(fd, signal.SIGKILL)
    finally:
        for fd in supervisors + legacy:
            os.close(fd)


if __name__ == "__main__":
    try:
        if len(sys.argv) >= 3 and sys.argv[1] == "run":
            sys.exit(supervise(sys.argv[2:]))
        if len(sys.argv) == 4 and sys.argv[1] == "stop":
            terminate(sys.argv[2], sys.argv[3])
        else:
            raise ValueError("expected run COMMAND... or stop MARKER VALUE")
    except Exception as error:
        print(f"run supervisor: {error}", file=sys.stderr)
        sys.exit(125)
