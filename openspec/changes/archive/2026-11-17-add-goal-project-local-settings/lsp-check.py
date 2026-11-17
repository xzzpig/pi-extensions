import json
import os
import pathlib
import queue
import subprocess
import sys
import threading
import time

root = next(
    parent / "packages/pi-goal-x"
    for parent in pathlib.Path(__file__).resolve().parents
    if (parent / "packages/pi-goal-x").is_dir()
)
files = [
    "extensions/goal-commands.ts",
    "extensions/goal-settings.ts",
    "extensions/widgets/goal-controls-dialog.ts",
    "extensions/fork-settings-layers.ts",
    "tests/goal-context-usage.test.ts",
    "tests/goal-controls.test.ts",
    "tests/goal-command-palette.test.ts",
    "tests/integration/extension.test.ts",
    "tests/integration/goal-auto-continue-gate-sdk.test.ts",
    "tests/fork-local-auditor.test.ts",
    "tests/fork-local-controls.test.ts",
    "tests/fork-local-mutation.test.ts",
    "tests/fork-local-race.test.ts",
    "tests/fork-local-settings-extra.test.ts",
    "tests/fork-local-settings-ui.test.ts",
    "tests/fork-local-settings.test.ts",
]
p = subprocess.Popen(
    ["typescript-language-server", "--stdio"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.DEVNULL,
)
q = queue.Queue()


def send(obj):
    b = json.dumps(obj).encode()
    stdin = p.stdin
    if stdin is None:
        raise RuntimeError("LSP stdin unavailable")
    stdin.write(b"Content-Length: " + str(len(b)).encode() + b"\r\n\r\n" + b)
    stdin.flush()


def reader():
    stdout = p.stdout
    if stdout is None:
        raise RuntimeError("LSP stdout unavailable")
    while True:
        h = {}
        while True:
            x = stdout.readline()
            if not x:
                return
            if x in (b"\r\n", b"\n"):
                break
            k, v = x.decode().split(":", 1)
            h[k.lower()] = v.strip()
        n = int(h.get("content-length", "0"))
        if n:
            try:
                q.put(json.loads(stdout.read(n)))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                q.put({"protocolError": str(exc)})
                return


threading.Thread(target=reader, daemon=True).start()
send(
    {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "processId": os.getpid(),
            "rootUri": root.as_uri(),
            "capabilities": {
                "textDocument": {"publishDiagnostics": {"versionSupport": True}}
            },
            "workspaceFolders": [{"uri": root.as_uri(), "name": "pi-goal-x"}],
        },
    }
)
deadline = time.monotonic() + 30
while time.monotonic() < deadline:
    m = q.get(timeout=30)
    if "protocolError" in m:
        raise RuntimeError(m["protocolError"])
    if m.get("id") == 1:
        break
send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
for file in files:
    f = root / file
    send(
        {
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": f.as_uri(),
                    "languageId": "typescript",
                    "version": 1,
                    "text": f.read_text(),
                }
            },
        }
    )
results = {}
deadline = time.monotonic() + 120
last = None
while time.monotonic() < deadline:
    try:
        m = q.get(timeout=1)
    except queue.Empty:
        if len(results) == len(files) and last and time.monotonic() - last > 5:
            break
        continue
    if "protocolError" in m:
        raise RuntimeError(m["protocolError"])
    if m.get("method") == "textDocument/publishDiagnostics":
        u = m["params"]["uri"]
        results[u] = m["params"]["diagnostics"]
        last = time.monotonic()
    elif m.get("id") is not None and m.get("method"):
        send({"jsonrpc": "2.0", "id": m["id"], "result": None})
for f in files:
    u = (root / f).as_uri()
    ds = results.get(u)
    if ds is None:
        print(f, "UNCONFIRMED")
    else:
        errors = [x for x in ds if x.get("severity", 1) == 1]
        print(f, "PUBLISHED", len(ds), "diagnostics", len(errors), "errors")
        for x in ds:
            print(
                " DIAG",
                x.get("severity"),
                x.get("code"),
                x.get("range", {}).get("start"),
                x.get("message", "").split("\n")[0],
            )
print("published", len(results), "/", len(files))
send({"jsonrpc": "2.0", "id": 2, "method": "shutdown", "params": None})
send({"jsonrpc": "2.0", "method": "exit", "params": None})
p.terminate()
sys.exit(
    0
    if len(results) == len(files)
    and not any(d.get("severity", 1) == 1 for a in results.values() for d in a)
    else 1
)
