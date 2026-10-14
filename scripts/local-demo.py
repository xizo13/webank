#!/usr/bin/env python3
"""Start and stop the isolated, loopback-only owner demonstration."""

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
RUNTIME = SCRIPTS / "local-demo-runtime"
STATE = RUNTIME / "state.json"
TOKEN = RUNTIME / "app-login-token"
SHOP = ROOT / "apps/shops"
APP = ROOT / "apps/webank-app"
GATEWAY = ROOT / "services/gateway"
CHAIN = SCRIPTS / "chain/runtime"
ADDRESSES = SCRIPTS / "chain/addresses.json"
SHOP_KEYS = SHOP / ".shop-local/merchant-keys.json"
NODE = shutil.which("node")
COREPACK = shutil.which("corepack")


def fail(message: str) -> None:
    raise RuntimeError(message)


def private_dir() -> None:
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    RUNTIME.chmod(0o700)


def log_file(name: str):
    fd = os.open(RUNTIME / name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    return os.fdopen(fd, "w")


def ps(pid: int, field: str) -> str:
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", f"{field}="],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def owned(record: dict, role: str) -> bool:
    pid = record["pid"]
    command = ps(pid, "command")
    if not command or ps(pid, "lstart") != record["started"]:
        return False
    needles = {
        "shop": ("next", "next-server"),
        "gateway": ("local-demo-server.ts",),
        "app": ("http.server 8081",),
    }
    return any(needle in command for needle in needles[role])


def stop_child(record: dict, role: str) -> bool:
    if not ps(record["pid"], "command"):
        return True
    if not owned(record, role):
        print(f"Refusing to stop {role}: PID identity changed", file=sys.stderr)
        return False
    try:
        os.killpg(record["pid"], signal.SIGTERM)
    except ProcessLookupError:
        return True
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline and ps(record["pid"], "command"):
        time.sleep(0.2)
    if ps(record["pid"], "command") and owned(record, role):
        os.killpg(record["pid"], signal.SIGKILL)
    return True


def write_state(state: dict) -> None:
    temporary = STATE.with_suffix(".json.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(state, output, indent=2)
        output.write("\n")
    temporary.replace(STATE)


def chain_pids() -> dict:
    path = CHAIN / "pids.json"
    return json.loads(path.read_text()) if path.is_file() else {}


def stop_chain(state: dict) -> bool:
    expected = state.get("chain_pids") or {}
    if not expected:
        return True
    current = chain_pids()
    if not current:
        return True
    if current != expected:
        print("Refusing to stop FISCO: node PIDs changed", file=sys.stderr)
        return False
    subprocess.run([str(SCRIPTS / "chain-down.sh")], cwd=ROOT, check=True)
    return True


def down(state: dict) -> bool:
    all_stopped = True
    for role in ("app", "gateway", "shop"):
        record = state.get("children", {}).get(role)
        if record:
            all_stopped = stop_child(record, role) and all_stopped
    all_stopped = stop_chain(state) and all_stopped
    if all_stopped:
        TOKEN.unlink(missing_ok=True)
        STATE.unlink(missing_ok=True)
    return all_stopped


def port_busy(port: int) -> bool:
    with socket.socket() as connection:
        connection.settimeout(0.3)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def request(url: str, *, payload: dict | None = None) -> tuple[int, bytes]:
    body = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if body else {}
    method = "POST" if body else "GET"
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, data=body, headers=headers, method=method),
            timeout=2,
        ) as response:
            return response.status, response.read(1024 * 1024)
    except urllib.error.HTTPError as error:
        return error.code, error.read(1024 * 1024)


def wait_ready(name: str, process: subprocess.Popen, probe, timeout: int = 45) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            fail(f"{name} exited early; see {RUNTIME / (name + '.log')}")
        try:
            if probe():
                return
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        time.sleep(0.5)
    fail(f"{name} did not become healthy; see {RUNTIME / (name + '.log')}")


def start(name: str, command: list[str], cwd: Path, env: dict, state: dict):
    with log_file(f"{name}.log") as output:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdout=output,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    started = ps(process.pid, "lstart")
    if not started:
        fail(f"{name} failed to start")
    state["children"][name] = {"pid": process.pid, "started": started}
    write_state(state)
    return process


def fingerprint(paths: list[Path], extras: list[str] | None = None) -> str:
    digest = hashlib.sha256()
    for root in paths:
        files = sorted(path for path in root.rglob("*") if path.is_file()) if root.is_dir() else [root]
        for path in files:
            digest.update(str(path.relative_to(ROOT)).encode() + b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
    for extra in extras or []:
        digest.update(extra.encode() + b"\0")
    return digest.hexdigest()


def run_build(name: str, command: list[str], cwd: Path, env: dict) -> None:
    print(f"Preparing {name}...")
    with log_file(f"build-{name}.log") as output:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT)
    if result.returncode:
        fail(f"{name} build failed; see {RUNTIME / ('build-' + name + '.log')}")


def prepare_builds() -> None:
    common = os.environ.copy()
    common["NEXT_TELEMETRY_DISABLED"] = "1"
    common["EXPO_NO_TELEMETRY"] = "1"
    for package, output in (
        ("@webank/contracts", ROOT / "packages/contracts/dist/index.js"),
        ("@webank/chain", ROOT / "packages/chain/dist/index.js"),
        ("@webank/guardian", ROOT / "services/guardian/dist/index.js"),
    ):
        if not output.is_file():
            run_build(package.replace("@webank/", ""), [COREPACK, "pnpm", "--filter", package, "build"], ROOT, common)
    shop_hash = fingerprint([SHOP / "app", SHOP / "lib", SHOP / "package.json"])
    shop_marker = RUNTIME / "shop-build.sha256"
    if not (SHOP / ".next/BUILD_ID").is_file() or not shop_marker.is_file() or shop_marker.read_text().strip() != shop_hash:
        run_build("shop", [NODE, str(SHOP / "node_modules/next/dist/bin/next"), "build"], SHOP, common)
        shop_marker.write_text(shop_hash + "\n")
    app_env = common.copy()
    app_env["EXPO_PUBLIC_GATEWAY_URL"] = "http://127.0.0.1:3002"
    app_env["EXPO_PUBLIC_LOCAL_DEMO"] = "1"
    app_hash = fingerprint(
        [APP / "App.tsx", APP / "src", APP / "app.json", APP / "index.ts", APP / "package.json"],
        [app_env["EXPO_PUBLIC_GATEWAY_URL"], app_env["EXPO_PUBLIC_LOCAL_DEMO"]],
    )
    app_marker = RUNTIME / "app-export.sha256"
    if not (APP / "dist/index.html").is_file() or not app_marker.is_file() or app_marker.read_text().strip() != app_hash:
        if (APP / "dist").exists():
            shutil.rmtree(APP / "dist")
        run_build(
            "app",
            [NODE, str(APP / "node_modules/expo/bin/cli"), "export", "--platform", "web", "--clear", "--output-dir", "dist"],
            APP,
            app_env,
        )
        if not (APP / "dist/index.html").is_file():
            fail("Expo export did not produce dist/index.html")
        app_marker.write_text(app_hash + "\n")


def read_gateway_env() -> dict:
    path = CHAIN / "gateway.env"
    if not path.is_file() or path.stat().st_mode & 0o077:
        fail("Private Gateway signer file is missing or has unsafe permissions")
    values = {}
    for line in path.read_text().splitlines():
        name, separator, value = line.partition("=")
        if separator and name in ("FISCO_GATEWAY_PRIVATE_KEY", "FISCO_PRIVATE_KEY"):
            values[name] = value
    if not re.fullmatch(r"0x[0-9a-fA-F]{64}", values.get("FISCO_GATEWAY_PRIVATE_KEY", "")):
        fail("Private Gateway signer file is invalid")
    return values


def archive_addresses() -> Path | None:
    if not ADDRESSES.is_file():
        return None
    archive = CHAIN / f"addresses-before-local-demo-{dt.datetime.now(dt.timezone.utc):%Y%m%dT%H%M%SZ}-{secrets.token_hex(3)}.json"
    ADDRESSES.replace(archive)
    archive.chmod(0o600)
    print(f"Archived prior address config at {archive}")
    return archive


def up(fresh: bool) -> None:
    if STATE.exists():
        fail(f"A launcher state already exists; run {SCRIPTS / 'local-demo-down.sh'} first")
    if not NODE or not COREPACK:
        fail("Node and Corepack are required; no dependency install will be attempted")
    if not (ROOT / "onchain/node_modules/solc").exists():
        fail("Pinned onchain dependencies are missing; refusing automatic install")
    local_chain_artifacts = {
        "FISCO_ARCHIVE_FILE": CHAIN / "fisco-bcos-v3.17.1-macOS-arm.tar.gz",
        "FISCO_BUILDER_FILE": CHAIN / "build_chain.sh",
        "FISCO_TASSL_BINARY": CHAIN / "home/.fisco/tassl-1.1.1b",
        "FISCO_ACCOUNT_HELPER_FILE": CHAIN / "home/.fisco/get_account.sh",
    }
    if any(not path.is_file() for path in local_chain_artifacts.values()) or not (CHAIN / "nodes").is_dir():
        fail("Pinned FISCO runtime is incomplete; refusing a download")
    if not (SHOP / "node_modules/next/dist/bin/next").is_file() or not (APP / "node_modules/expo/bin/cli").is_file():
        fail("Shop or app dependencies are missing; refusing automatic install")
    if chain_pids():
        fail("FISCO nodes already have an operator PID file; stop that chain deliberately first")
    for port in (3001, 3002, 8081, 8545):
        if port_busy(port):
            fail(f"Loopback port {port} is already in use")
    free = os.statvfs(ROOT).f_bavail * os.statvfs(ROOT).f_frsize
    if free < 1024**3:
        fail(f"Only {free} bytes are free; need at least 1 GiB for the local demo")
    print(f"Preflight: {free} bytes available; no project listener will be reused")
    prepare_builds()
    state = {"version": 1, "children": {}, "chain_pids": {}, "created_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    write_state(state)
    old_keys = hashlib.sha256(SHOP_KEYS.read_bytes()).hexdigest() if SHOP_KEYS.is_file() else None
    shop_token = secrets.token_urlsafe(32)
    try:
        shop_env = {**os.environ, "SHOP_INTERNAL_TOKEN": shop_token, "NEXT_TELEMETRY_DISABLED": "1"}
        shop = start("shop", [NODE, str(SHOP / "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3001"], SHOP, shop_env, state)

        def shop_ready():
            status, body = request("http://127.0.0.1:3001/api/merchants")
            data = json.loads(body) if status == 200 else {}
            return status == 200 and data.get("simulated") is True and len(data.get("merchants", [])) == 4

        wait_ready("shop", shop, shop_ready)
        if old_keys and hashlib.sha256(SHOP_KEYS.read_bytes()).hexdigest() != old_keys:
            fail("Shop merchant keys changed unexpectedly")
        archived = archive_addresses() if fresh else None
        with log_file("chain-up.log") as output:
            result = subprocess.run(
                [str(SCRIPTS / "chain-up.sh"), "--merchants-url", "http://127.0.0.1:3001/api/merchants"],
                cwd=ROOT,
                env={**os.environ, **{name: str(path) for name, path in local_chain_artifacts.items()}},
                stdout=output,
                stderr=subprocess.STDOUT,
            )
        state["chain_pids"] = chain_pids()
        write_state(state)
        if result.returncode:
            fail(f"FISCO startup or seed failed; see {RUNTIME / 'chain-up.log'}")
        if len(state["chain_pids"]) != 4:
            fail("FISCO did not register four node PIDs")
        status, body = request("http://127.0.0.1:8545", payload={"jsonrpc": "2.0", "method": "eth_chainId", "params": [], "id": 1})
        if status != 200 or int(json.loads(body)["result"], 16) != 20200:
            fail("FISCO Web3 RPC has the wrong chain ID")
        addresses = json.loads(ADDRESSES.read_text())
        if not addresses.get("txHashes", {}).get("fundWallet"):
            fail("Deployment lacks a funded wallet transaction")
        if archived and json.loads(archived.read_text()).get("agentWallet") == addresses.get("agentWallet"):
            fail("Fresh deployment reused the old AgentWallet address")
        gateway_env = {
            **os.environ,
            **read_gateway_env(),
            "WEBANK_LOCAL_DEMO": "1",
            "WEBANK_DEMO_APPROVALS": "1",
            "WEBANK_DEMO_APP_ORIGIN": "http://127.0.0.1:8081",
            "WEBANK_SHOP_URL": "http://127.0.0.1:3001",
            "WEBANK_LOCAL_DEMO_PORT": "3002",
            "FISCO_RPC_URL": "http://127.0.0.1:8545",
            "SHOP_INTERNAL_TOKEN": shop_token,
            "WEBANK_LOCAL_DEMO_TOKEN_FILE": str(TOKEN),
        }
        TOKEN.unlink(missing_ok=True)
        gateway = start("gateway", [NODE, "--import", "tsx", "src/local-demo-server.ts"], GATEWAY, gateway_env, state)
        wait_ready("gateway", gateway, lambda: TOKEN.is_file() and request("http://127.0.0.1:3002/v1/app/agents")[0] == 401)
        app = start("app", [sys.executable, "-m", "http.server", "8081", "--bind", "127.0.0.1", "--directory", str(APP / "dist")], ROOT, os.environ.copy(), state)
        wait_ready("app", app, lambda: request("http://127.0.0.1:8081/")[0] == 200)
        print("SIMULATED local demo ready: http://127.0.0.1:8081")
        print("Shop: http://127.0.0.1:3001  Gateway: http://127.0.0.1:3002  FISCO RPC: http://127.0.0.1:8545")
        print(f"One-time app login token: read {TOKEN} locally (mode 0600); it is not logged")
        print(f"Stop with: {SCRIPTS / 'local-demo-down.sh'}")
    except BaseException:
        down(state)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("up").add_argument("--fresh", action="store_true", help="Archive current addresses and deploy a new funded wallet")
    commands.add_parser("down")
    args = parser.parse_args()
    private_dir()
    with (RUNTIME / "operator.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if args.command == "up":
            up(args.fresh)
        elif STATE.exists():
            if not down(json.loads(STATE.read_text())):
                fail("Some PID identities changed; inspect state before retrying")
            print("Local demo stopped; signer files and chain history preserved")
        else:
            print("No launcher-owned local demo is running")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"local demo failed: {error}", file=sys.stderr)
        sys.exit(1)
