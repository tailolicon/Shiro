#!/usr/bin/env python3
"""Pseudo-terminal host for Shiro's terminal_* direct actions.

Node has no pty binding in core and the bridge deliberately ships no native
dependency, so one small stdlib-only Python process owns each pty instead.

Protocol, all newline-delimited JSON on this process's stdin:

  first line  {"argv":[...],"cwd":"...","env":{...},"cols":120,"rows":32}
  then        {"t":"i","d":"<base64 bytes to type>"}
              {"t":"r","cols":N,"rows":N}
              {"t":"s","sig":"INT"}        signal the child's process group
              {"t":"q"}                    terminate the child

stdout carries the raw pty output, byte for byte, so the caller can keep an
exact byte offset. stderr carries lifecycle records, one JSON object per line:
{"event":"started","pid":N} / {"event":"exit","code":N,"signal":N} /
{"event":"error","message":"..."}. Keeping the two streams apart is what lets
the parent tell "the program printed something" from "the program is gone".
"""

import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios

READ_SIZE = 65536


def emit(record):
    try:
        sys.stderr.write(json.dumps(record) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def set_size(fd, rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def write_all(fd, data):
    while data:
        written = os.write(fd, data)
        data = data[written:]


def kill_child(pid):
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
    except OSError:
        pass


def read_spec():
    buffer = b""
    while not buffer.endswith(b"\n"):
        chunk = os.read(0, 1)
        if not chunk:
            raise SystemExit(0)
        buffer += chunk
    return json.loads(buffer)


def main():
    spec = read_spec()
    argv = list(spec.get("argv") or [])
    if not argv:
        emit({"event": "error", "message": "argv is required"})
        return 2
    cwd = spec.get("cwd") or os.getcwd()
    env = dict(spec.get("env") or {})
    rows = max(1, min(int(spec.get("rows", 32)), 1000))
    cols = max(1, min(int(spec.get("cols", 120)), 2000))

    pid, master = pty.fork()
    if pid == 0:
        # Child: pty.fork() already made this a session leader whose controlling
        # terminal is the pty slave, so the program sees a real interactive tty.
        try:
            os.chdir(cwd)
            os.execvpe(argv[0], argv, env)
        except Exception as error:  # noqa: BLE001 - surfaced through the pty
            os.write(2, ("shiro-terminal: cannot start %s: %s\n" % (argv[0], error)).encode())
        os._exit(127)

    set_size(master, rows, cols)
    emit({"event": "started", "pid": pid})

    pending = b""
    draining = True
    stdin_open = True

    def handle(line):
        if not line.strip():
            return
        try:
            message = json.loads(line)
            kind = message.get("t")
            if kind == "i":
                write_all(master, base64.b64decode(message.get("d") or ""))
            elif kind == "r":
                set_size(master, max(1, int(message.get("rows", rows))), max(1, int(message.get("cols", cols))))
            elif kind == "s":
                number = getattr(signal, "SIG" + str(message.get("sig", "TERM")).upper(), None)
                if number is None:
                    emit({"event": "error", "message": "unknown signal %s" % message.get("sig")})
                else:
                    os.killpg(os.getpgid(pid), number)
            elif kind == "q":
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            else:
                emit({"event": "error", "message": "unknown control message %r" % kind})
        except Exception as error:  # noqa: BLE001 - one bad control line must not kill the pty
            emit({"event": "error", "message": str(error)})

    # The loop ends when the pty master reports EOF: on Linux that EIO is the
    # authoritative "the child and every process holding the slave are gone",
    # and it arrives only after the last byte of output has been read, so no
    # output is lost between the exit and the final read.
    while draining:
        watched = [master] + ([0] if stdin_open else [])
        try:
            readable, _, _ = select.select(watched, [], [], 0.25)
        except (InterruptedError, OSError):
            continue

        if master in readable:
            try:
                data = os.read(master, READ_SIZE)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                data = b""
            if data:
                try:
                    write_all(1, data)
                except BrokenPipeError:
                    kill_child(pid)
                    break
            else:
                draining = False
                break

        if stdin_open and 0 in readable:
            chunk = os.read(0, READ_SIZE)
            if not chunk:
                # The bridge went away: never leave an orphan shell behind.
                stdin_open = False
                kill_child(pid)
                continue
            pending += chunk
            while b"\n" in pending:
                line, pending = pending.split(b"\n", 1)
                handle(line)

    try:
        _, status = os.waitpid(pid, 0)
    except OSError:
        status = 0
    if os.WIFSIGNALED(status):
        emit({"event": "exit", "code": None, "signal": os.WTERMSIG(status)})
    else:
        emit({"event": "exit", "code": os.WEXITSTATUS(status), "signal": None})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        emit({"event": "error", "message": str(error)})
        sys.exit(1)
