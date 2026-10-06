#!/usr/bin/env python3
"""Start the Codex <-> DeepSeek Harness bridge (console + broker).

Two processes make up the bridge, and both are needed:

  console (default port 8792)  the web page: list sessions, connect two of them
  broker  (default port 8791)  the relay: actually carries messages both ways

This launcher starts whichever is not already running, waits until each one
answers, prints the URL, and optionally opens the browser. Re-running it is safe:
an already-listening port is reused instead of starting a duplicate, because two
relays sharing one state file would fight over the delivery cursor.

Usage
-----
    python start-bridge.py                 # start both, print the URL
    python start-bridge.py --open          # also open the browser
    python start-bridge.py --console-only  # web page only
    python start-bridge.py --status        # report state, change nothing
    python start-bridge.py --stop          # stop both

Unusual installs are discovered automatically (running process paths plus
probing). If discovery fails, point it at the real locations:

    python start-bridge.py --codex-home D:\\x\\.codex --dsh-home D:\\x\\.dsh
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONSOLE_SCRIPT = HERE / "session-server.mjs"
BROKER_SCRIPT = HERE / "broker.mjs"
DEFAULT_STATE = HERE / "state.json"
CONSOLE_LOG = HERE / "console.log"
BROKER_LOG = HERE / "broker.log"

DEFAULT_CONSOLE_PORT = 8792
DEFAULT_BROKER_PORT = 8791


def find_node() -> str | None:
    """Locate the Node executable.

    Checks PATH first, then the DSH runtime's bundled Node, because a machine can
    run the DSH desktop app without having Node installed globally.
    """
    from shutil import which

    found = which("node")
    if found:
        return found

    candidates = [
        Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "nodejs" / "node.exe",
        Path(os.environ.get("DSH_HOME", "")) / "dsh-runtimes" / "dsh-primary-runtime"
        / "dependencies" / "node" / "bin" / "node.exe",
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "DeepSeek Harness"
        / "resources" / "runtime" / "bin" / "node.exe",
    ]
    for candidate in candidates:
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return None


def port_listening(port: int) -> bool:
    """Whether something is listening on 127.0.0.1:port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.6)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def http_ok(url: str, timeout: float = 2.0) -> bool:
    """Whether a GET returns 2xx."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return 200 <= response.status < 300
    except (urllib.error.URLError, OSError, ValueError):
        return False


def start_detached(args: list[str], log_path: Path, env: dict[str, str]) -> subprocess.Popen:
    """Start a child that outlives this launcher.

    The child's stdout goes to a file rather than a pipe on purpose: a pipe would
    hold the launcher open until the child exits, and this launcher must return as
    soon as the service is up.
    """
    log_path.parent.mkdir(parents=True, exist_ok=True)
    stream = open(log_path, "a", encoding="utf-8", buffering=1)
    creation = 0
    if os.name == "nt":
        # Detach from this console so closing the terminal does not kill the service.
        creation = subprocess.CREATE_NEW_PROCESS_GROUP | 0x00000008  # DETACHED_PROCESS
    return subprocess.Popen(
        args,
        stdout=stream,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        cwd=str(HERE),
        env=env,
        creationflags=creation,
        close_fds=True,
    )


def wait_for(check, seconds: float, label: str) -> bool:
    """Poll until check() is true, or give up after seconds."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.3)
    print(f"  ! {label} did not come up within {seconds:.0f}s", file=sys.stderr)
    return False


def ensure_broker(node: str, port: int, state: Path, dsh_home: str | None) -> tuple[bool, bool]:
    """Ensure the relay broker is running. Returns (running, started_now)."""
    if port_listening(port):
        return True, False
    env = dict(os.environ)
    env["DSH_BRIDGE_STATE"] = str(state)
    if dsh_home:
        env["DSH_HOME"] = dsh_home
    elif not env.get("DSH_HOME"):
        env["DSH_HOME"] = str(Path.home() / ".dsh")
    start_detached(
        [node, str(BROKER_SCRIPT), "serve", "--port", str(port), "--log", str(BROKER_LOG)],
        BROKER_LOG,
        env,
    )
    ok = wait_for(lambda: port_listening(port), 25, f"broker on {port}")
    return ok, ok


def ensure_console(
    node: str,
    port: int,
    broker_port: int,
    state: Path,
    dsh_home: str | None,
    dsh_url: str | None,
    codex_home: str | None,
) -> tuple[bool, bool]:
    """Ensure the web console is running. Returns (running, started_now)."""
    if port_listening(port):
        return True, False
    env = dict(os.environ)
    env["DSH_BRIDGE_STATE"] = str(state)
    env["DSH_BRIDGE_BROKER_URL"] = f"http://127.0.0.1:{broker_port}"
    if dsh_home:
        env["DSH_HOME"] = dsh_home
    args = [node, str(CONSOLE_SCRIPT), "--port", str(port), "--log", str(CONSOLE_LOG)]
    if codex_home:
        args += ["--codex-home", codex_home]
    if dsh_home:
        args += ["--dsh-home", dsh_home]
    if dsh_url:
        args += ["--dsh-url", dsh_url]
    start_detached(args, CONSOLE_LOG, env)
    ok = wait_for(lambda: port_listening(port), 40, f"console on {port}")
    return ok, ok


def stop_port(port: int) -> bool:
    """Stop whatever owns a listening port on 127.0.0.1. Returns whether it stopped."""
    if os.name != "nt":
        print("  ! --stop is implemented for Windows only", file=sys.stderr)
        return False
    script = (
        f"$c = Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue; "
        "if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; 'stopped' } else { 'not-running' }"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        timeout=60,
    )
    print(f"  port {port}: {result.stdout.strip() or 'no output'}")
    return "stopped" in result.stdout


def session_counts(port: int) -> str:
    """Summarize what the console reports, so a start can be verified at a glance."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/sessions", timeout=25) as response:
            body = json.load(response)
        codex = len(body.get("codex", {}).get("sessions", []))
        dsh = len(body.get("dsh", {}).get("sessions", []))
        return f"codex={codex}, dsh={dsh}"
    except Exception as error:  # noqa: BLE001 - a summary must never fail the launch
        return f"(unavailable: {error})"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Start the Codex <-> DeepSeek Harness bridge (console + broker).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--port", type=int, default=DEFAULT_CONSOLE_PORT, help="console port (default 8792)")
    parser.add_argument("--broker-port", type=int, default=DEFAULT_BROKER_PORT, help="broker port (default 8791)")
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE, help="pairing state file")
    parser.add_argument("--codex-home", help="explicit Codex home (when discovery fails)")
    parser.add_argument("--dsh-home", help="explicit DSH home (when discovery fails)")
    parser.add_argument("--dsh-url", help="explicit DSH web URL (default http://127.0.0.1:19387)")
    parser.add_argument("--open", action="store_true", help="open the console in the default browser")
    parser.add_argument("--console-only", action="store_true", help="start only the web console")
    parser.add_argument("--status", action="store_true", help="report state and exit")
    parser.add_argument("--stop", action="store_true", help="stop both processes")
    opts = parser.parse_args()

    console_url = f"http://127.0.0.1:{opts.port}/"
    broker_url = f"http://127.0.0.1:{opts.broker_port}/"

    if opts.status:
        print("bridge status")
        print(f"  console {opts.port}: {'listening' if port_listening(opts.port) else 'DOWN'}")
        if not opts.console_only:
            print(f"  broker  {opts.broker_port}: {'listening' if port_listening(opts.broker_port) else 'DOWN'}")
        if port_listening(opts.port):
            print(f"  page    : HTTP {'200' if http_ok(console_url) else 'unreachable'}")
            print(f"  sessions: {session_counts(opts.port)}")
        return 0

    if opts.stop:
        stop_port(opts.port)
        if not opts.console_only:
            stop_port(opts.broker_port)
        return 0

    node = find_node()
    if node is None:
        print("error: cannot find node.exe; install Node.js or add it to PATH", file=sys.stderr)
        return 2

    started_any = False
    if not opts.console_only:
        running, started = ensure_broker(node, opts.broker_port, opts.state, opts.dsh_home)
        started_any = started_any or started
        print(f"broker  {opts.broker_port}: {'started' if started else 'already running' if running else 'FAILED'}")

    running, started = ensure_console(
        node,
        opts.port,
        opts.broker_port,
        opts.state,
        opts.dsh_home,
        opts.dsh_url,
        opts.codex_home,
    )
    started_any = started_any or started
    print(f"console {opts.port}: {'started' if started else 'already running' if running else 'FAILED'}")

    if not running:
        print(f"\nstartup failed; see {CONSOLE_LOG}", file=sys.stderr)
        return 1

    healthy = wait_for(lambda: http_ok(console_url), 20, "console HTTP")
    print()
    print(f"  open this: {console_url}")
    if not opts.console_only:
        print(f"  relay    : {broker_url} (owns relaying)")
    print(f"  sessions : {session_counts(opts.port) if healthy else '(page not answering yet)'}")
    if started_any:
        print(f"  logs     : {CONSOLE_LOG}")
    print()
    print("  Pick one Codex session and one DSH session in the page, then press 连接所选两个会话.")

    if opts.open:
        if os.name == "nt":
            os.startfile(console_url)  # noqa: S606 - opening a local URL is the intent
        else:
            from webbrowser import open as open_browser

            open_browser(console_url)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
