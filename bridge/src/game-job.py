#!/usr/bin/env python3
"""Receipt-backed argv runner. Receipts/logs survive connector reloads."""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time


def main():
    spec_path = Path(sys.argv[1]).resolve()
    spec = json.loads(spec_path.read_text())
    folder = spec_path.parent
    start = dt.datetime.now(dt.timezone.utc).isoformat()
    receipt = {"status": "running", "started_at": start, "argv": spec["argv"],
               "cwd": spec["cwd"], "timeout_seconds": spec.get("timeout_seconds", 300)}
    result_path = folder / "result.json"
    def save():
        temp = result_path.with_suffix(".tmp")
        temp.write_text(json.dumps(receipt, indent=2) + "\n")
        os.replace(temp, result_path)
    save()
    child = None
    interrupted = False
    def stop_tree():
        if child is None: return
        try:
            if os.name == "posix": os.killpg(child.pid, signal.SIGTERM)
            elif child.poll() is None: child.terminate()
        except ProcessLookupError: pass
        try: child.wait(timeout=0.8)
        except subprocess.TimeoutExpired: pass
        try:
            if os.name == "posix": os.killpg(child.pid, signal.SIGKILL)
            elif child.poll() is None: child.kill()
        except ProcessLookupError: pass
    def interrupt(signum, frame):
        nonlocal interrupted
        interrupted = True
        stop_tree()
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    stats = {}
    def drain(stream, name):
        total = written = 0
        digest = hashlib.sha256()
        limit = int(spec.get("log_limit_bytes", 67108864))
        with (folder / (name + ".log")).open("wb") as output:
            while True:
                data = stream.read(65536)
                if not data: break
                total += len(data)
                retained = data[:max(0, limit - written)]
                output.write(retained)
                digest.update(retained)
                written += len(retained)
        stream.close()
        stats[name] = {"bytes": total, "retained_bytes": written, "truncated": total > written,
                       "sha256": digest.hexdigest(), "path": name + ".log"}
    try:
        child = subprocess.Popen(spec["argv"], cwd=spec["cwd"], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False,
                                 start_new_session=os.name == "posix")
        receipt["pid"] = child.pid
        save()
        threads = [threading.Thread(target=drain, args=(stream, name), daemon=True)
                   for stream, name in ((child.stdout, "stdout"), (child.stderr, "stderr"))]
        for thread in threads: thread.start()
        timed_out = False
        try:
            code = child.wait(timeout=spec.get("timeout_seconds", 300))
        except subprocess.TimeoutExpired:
            timed_out = True
            stop_tree()
            code = child.wait(timeout=5)
        for thread in threads: thread.join(timeout=10)
        receipt.update(status="interrupted" if interrupted else "timeout" if timed_out else "completed",
                       exit_code=code, success=code == 0 and not timed_out and not interrupted,
                       logs=stats, ended_at=dt.datetime.now(dt.timezone.utc).isoformat())
    except Exception as exc:
        receipt.update(status="failed", success=False, error=str(exc),
                       ended_at=dt.datetime.now(dt.timezone.utc).isoformat())
    save()
    print(json.dumps({"receipt": str(result_path), "status": receipt["status"],
                      "success": receipt.get("success", False), "exit_code": receipt.get("exit_code")}))
    return 0 if receipt.get("success") else 1

if __name__ == "__main__":
    raise SystemExit(main())
