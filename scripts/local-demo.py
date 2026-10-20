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
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
RUNTIME = SCRIPTS / "local-demo-runtime"
STATE = RUNTIME / "state.json"
TOKEN = RUNTIME / "app-login-token"
GATEWAY_STATE = RUNTIME / "gateway-state.json"
FUNDING_CUTOVER = RUNTIME / "funding-cutover.json"
SHOP = ROOT / "apps/shops"
APP = ROOT / "apps/webank-app"
GATEWAY = ROOT / "services/gateway"
CHAIN = SCRIPTS / "chain/runtime"
ADDRESSES = SCRIPTS / "chain/addresses.json"
FUNDING_STAGE = CHAIN / "funding-stage.json"
FRESH_PENDING = CHAIN / "fresh-deployment-pending.json"
NATIVE_FUNDED_TXS = {"deployECnySim", "deployMerchantRegistry", "deployLicenceRegistry", "deployAuditAnchor", "deployAgentWallet", "openingMint", "configureAgentWallet"}
SHOP_KEYS = SHOP / ".shop-local/merchant-keys.json"
SHOP_STATE = SHOP / ".shop-local/state.json"
FRESH_RESET = RUNTIME / "fresh-reset.json"
def project_node() -> str | None:
    explicit = os.environ.get("WEBANK_NODE_BINARY")
    directories = os.environ.get("PATH", "").split(os.pathsep)
    candidates = [Path(explicit)] if explicit else [
        *(Path(directory) / "node" for directory in directories if directory),
        Path("/usr/local/bin/node"),
        Path("/opt/homebrew/bin/node"),
    ]
    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen or not candidate.is_file() or not os.access(candidate, os.X_OK):
            continue
        seen.add(candidate)
        result = subprocess.run([str(candidate), "--version"], capture_output=True, text=True, check=False)
        if result.returncode == 0 and re.fullmatch(r"v22\.\d+\.\d+", result.stdout.strip()):
            return str(candidate)
    return None


NODE = project_node()
COREPACK = shutil.which("corepack")


def runtime_env(base: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base is None else base)
    for name in tuple(env):
        if name.startswith("WEBANK_GUARDIAN_HERMES_"):
            env.pop(name)
    if NODE:
        env["PATH"] = str(Path(NODE).parent) + os.pathsep + env.get("PATH", "")
    return env


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


def lsof_fields(pid: int, *filters: str) -> dict[str, list[str]] | None:
    result = subprocess.run(
        ["lsof", "-nP", "-Fpcun", "-a", "-p", str(pid), *filters],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None
    fields: dict[str, list[str]] = {}
    for line in result.stdout.splitlines():
        if line:
            fields.setdefault(line[0], []).append(line[1:])
    return fields


def owned(record: dict, role: str) -> bool:
    pid = record.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        return False
    expected = {
        "shop": (3001, SHOP, "node"),
        "gateway": (3002, GATEWAY, "node"),
        "app": (8081, ROOT, "python"),
    }
    if role not in expected:
        return False
    port, cwd, executable = expected[role]
    try:
        if os.getpgid(pid) != pid:
            return False
    except (ProcessLookupError, PermissionError):
        return False
    listener = lsof_fields(pid, f"-iTCP:{port}", "-sTCP:LISTEN")
    directory = lsof_fields(pid, "-d", "cwd")
    if not listener or not directory:
        return False
    return (
        listener.get("p") == [str(pid)]
        and directory.get("p") == [str(pid)]
        and listener.get("u") == [str(os.getuid())]
        and directory.get("u") == [str(os.getuid())]
        and any(name.lower().startswith(executable) for name in listener.get("c", []))
        and listener.get("n") == [f"127.0.0.1:{port}"]
        and directory.get("n") == [str(cwd.resolve())]
    )


def stop_child(record: dict, role: str) -> bool:
    try:
        os.getpgid(record["pid"])
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    if not owned(record, role):
        print(f"Refusing to stop {role}: PID does not match the expected loopback listener and working directory", file=sys.stderr)
        return False
    try:
        os.killpg(record["pid"], signal.SIGTERM)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        try:
            os.getpgid(record["pid"])
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        time.sleep(0.2)
    if owned(record, role):
        try:
            os.killpg(record["pid"], signal.SIGKILL)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            try:
                os.getpgid(record["pid"])
            except ProcessLookupError:
                return True
            except PermissionError:
                return False
            time.sleep(0.1)
        print(f"Refusing to continue: {role} did not exit after SIGKILL", file=sys.stderr)
        return False
    print(f"Refusing to force-stop {role}: PID identity is no longer verifiable", file=sys.stderr)
    return False


def write_state(state: dict) -> None:
    temporary = STATE.with_suffix(".json.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(state, output, indent=2)
        output.write("\n")
    temporary.replace(STATE)


def write_private_json(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(value, output, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


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
    if all_stopped:
        all_stopped = stop_chain(state)
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


def chain_receipt(tx_hash: str) -> dict | None:
    status, body = request(
        "http://127.0.0.1:8545",
        payload={"jsonrpc": "2.0", "method": "eth_getTransactionReceipt", "params": [tx_hash], "id": 1},
    )
    if status != 200:
        fail("FISCO transaction receipt lookup failed")
    result = json.loads(body)
    if result.get("error") or not isinstance(result.get("result"), (dict, type(None))):
        fail("FISCO transaction receipt response is invalid")
    return result["result"]


def verify_deployment_funding(addresses: dict, staged: dict | None = None, receipt_lookup=chain_receipt) -> None:
    tx_hashes = addresses.get("txHashes")
    if not isinstance(tx_hashes, dict):
        fail("Deployment transaction hashes are missing")
    transfer_topic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

    def receipt(name: str, expected_to: str | None = None, deployed: str | None = None) -> dict:
        tx_hash = tx_hashes.get(name)
        if not isinstance(tx_hash, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", tx_hash):
            fail(f"Deployment {name} transaction hash is missing or invalid")
        value = receipt_lookup(tx_hash)
        if not isinstance(value, dict) or value.get("status") not in ("0x1", "0x01"):
            fail(f"Deployment {name} transaction is not confirmed successful")
        if str(value.get("transactionHash", "")).lower() != tx_hash.lower():
            fail(f"Deployment {name} receipt does not match its transaction hash")
        block_number = value.get("blockNumber")
        if not isinstance(block_number, str) or not re.fullmatch(r"0x[0-9a-fA-F]+", block_number):
            fail(f"Deployment {name} receipt has no confirmed block")
        if expected_to is not None and str(value.get("to", "")).lower() != expected_to.lower():
            fail(f"Deployment {name} transaction targets another contract")
        if deployed is not None and str(value.get("contractAddress", "")).lower() != deployed.lower():
            fail(f"Deployment {name} created another contract")
        return value

    migration = addresses.get("migration")
    if migration is None and "fundWallet" not in tx_hashes:
        if addresses.get("chainId") != 20200 or addresses.get("rpcUrl") != "http://127.0.0.1:8545":
            fail("Fresh funded deployment is on another chain")
        for name in ("bank", "gateway", "ecnySim", "agentWallet", "merchantRegistry", "licenceRegistry", "auditAnchor"):
            if not isinstance(addresses.get(name), str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", addresses[name]):
                fail(f"Fresh funded deployment {name} address is invalid")
        if not isinstance(addresses.get("deploymentFingerprint"), str) or not re.fullmatch(r"[0-9a-fA-F]{64}", addresses["deploymentFingerprint"]):
            fail("Fresh funded deployment fingerprint is invalid")
        if set(tx_hashes) != NATIVE_FUNDED_TXS:
            fail("Fresh funded deployment has incomplete transaction evidence")
        for name, field in (("deployECnySim", "ecnySim"), ("deployMerchantRegistry", "merchantRegistry"), ("deployLicenceRegistry", "licenceRegistry"), ("deployAuditAnchor", "auditAnchor"), ("deployAgentWallet", "agentWallet")):
            receipt(name, deployed=addresses[field])
        verify_funded_main_receipts(addresses, receipt, transfer_topic)
        return
    if migration is None:
        for name in ("bank", "ecnySim", "agentWallet"):
            if not isinstance(addresses.get(name), str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", addresses[name]):
                fail(f"Legacy deployment {name} address is invalid")
        funded = receipt("fundWallet", expected_to=addresses["ecnySim"])
        bank_topic = "0x" + addresses["bank"].lower().removeprefix("0x").rjust(64, "0")
        wallet_topic = "0x" + addresses["agentWallet"].lower().removeprefix("0x").rjust(64, "0")
        transfers = [
            log for log in funded.get("logs", [])
            if isinstance(log, dict)
            and str(log.get("address", "")).lower() == addresses["ecnySim"].lower()
            and isinstance(log.get("topics"), list)
            and [str(topic).lower() for topic in log["topics"]] == [transfer_topic, bank_topic, wallet_topic]
            and isinstance(log.get("data"), str)
            and re.fullmatch(r"0x[0-9a-fA-F]{64}", log["data"])
            and int(log["data"], 16) > 0
        ]
        if len(transfers) != 1:
            fail("Legacy deployment lacks an exact wallet funding transfer")
        return
    if not isinstance(migration, dict) or migration.get("state") != "active":
        fail("Funding migration is not active")
    if staged is None or not isinstance(staged.get("migration"), dict):
        fail("Private staged funding manifest is missing")
    expected = json.loads(json.dumps(staged))
    if expected["migration"].get("state") != "staged":
        fail("Private staged funding manifest is invalid")
    expected["migration"]["state"] = "active"
    if addresses != expected:
        fail("Active funding deployment differs from the verified staged manifest")
    if addresses.get("chainId") != 20200 or addresses.get("rpcUrl") != "http://127.0.0.1:8545":
        fail("Active funding deployment is on another chain")
    for name in ("bank", "gateway", "ecnySim", "agentWallet", "merchantRegistry", "licenceRegistry", "auditAnchor"):
        if not isinstance(addresses.get(name), str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", addresses[name]):
            fail(f"Active funding deployment {name} address is invalid")
    fingerprint = addresses.get("deploymentFingerprint")
    if not isinstance(fingerprint, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", fingerprint):
        fail("Active funding deployment fingerprint is invalid")
    if set(tx_hashes) != {"deployECnySim", "deployAgentWallet", "openingMint", "configureAgentWallet"}:
        fail("Active funding deployment has incomplete transaction evidence")
    receipt("deployECnySim", deployed=addresses["ecnySim"])
    receipt("deployAgentWallet", deployed=addresses["agentWallet"])
    verify_funded_main_receipts(addresses, receipt, transfer_topic)
    prior = migration.get("priorAddresses")
    prior_hash = migration.get("priorReceiptHash")
    prior_fingerprint = migration.get("priorDeploymentFingerprint")
    prior_addresses_valid = isinstance(prior, dict) and all(
        isinstance(prior.get(name), str)
        and re.fullmatch(r"0x[0-9a-fA-F]{40}", prior[name])
        for name in ("ecnySim", "agentWallet")
    )
    if (
        not prior_addresses_valid
        or not isinstance(prior_fingerprint, str)
        or not re.fullmatch(r"[0-9a-fA-F]{64}", prior_fingerprint)
        or not isinstance(prior_hash, str)
        or not re.fullmatch(r"0x[0-9a-fA-F]{64}", prior_hash)
    ):
        fail("Funding migration prior payment proof is missing")
    paid = receipt_lookup(prior_hash)
    paid_topic = "0xbb4b659a1c76dc81c196c5d5bfd8cf796faffb9bdd4ec7f14f59a27ee28cd311"
    if (
        not isinstance(paid, dict)
        or paid.get("status") not in ("0x1", "0x01")
        or str(paid.get("transactionHash", "")).lower() != prior_hash.lower()
        or str(paid.get("to", "")).lower() != prior["agentWallet"].lower()
    ):
        fail("Funding migration prior Paid receipt is invalid")
    logs = paid.get("logs")
    if not isinstance(logs, list):
        fail("Funding migration prior Paid receipt has no logs")
    paid_logs = [
        log for log in logs
        if isinstance(log, dict)
        and str(log.get("address", "")).lower() == prior["agentWallet"].lower()
        and isinstance(log.get("topics"), list)
        and len(log["topics"]) == 4
        and str(log["topics"][0]).lower() == paid_topic
    ]
    if len(paid_logs) != 1:
        fail("Funding migration requires one exact old-wallet Paid event")
    paid_event = paid_logs[0]
    payout_topic = str(paid_event["topics"][3]).lower()
    amount_hex = paid_event.get("data")
    if (
        not re.fullmatch(r"0x[0-9a-f]{64}", payout_topic)
        or not isinstance(amount_hex, str)
        or not re.fullmatch(r"0x[0-9a-fA-F]{64}", amount_hex)
    ):
        fail("Funding migration Paid event is malformed")
    amount = int(amount_hex, 16)
    if amount <= 0:
        fail("Funding migration Paid amount is invalid")
    wallet_topic = "0x" + prior["agentWallet"].lower().removeprefix("0x").rjust(64, "0")
    transfers = [
        log for log in logs
        if isinstance(log, dict)
        and str(log.get("address", "")).lower() == prior["ecnySim"].lower()
        and isinstance(log.get("topics"), list)
        and [str(topic).lower() for topic in log["topics"]] == [transfer_topic, wallet_topic, payout_topic]
        and isinstance(log.get("data"), str)
        and re.fullmatch(r"0x[0-9a-fA-F]{64}", log["data"])
        and int(log["data"], 16) == amount
    ]
    if len(transfers) != 1:
        fail("Funding migration Paid event lacks its exact token transfer")


def verify_funded_main_receipts(addresses: dict, receipt, transfer_topic: str) -> None:
    mint = receipt("openingMint", expected_to=addresses["ecnySim"])
    bank_topic = "0x" + addresses["bank"].lower().removeprefix("0x").rjust(64, "0")
    expected_mint = [transfer_topic, "0x" + "0" * 64, bank_topic]
    mint_logs = mint.get("logs")
    if not isinstance(mint_logs, list) or len([
        log for log in mint_logs
        if isinstance(log, dict)
        and str(log.get("address", "")).lower() == addresses["ecnySim"].lower()
        and isinstance(log.get("topics"), list)
        and [str(topic).lower() for topic in log["topics"]] == expected_mint
        and isinstance(log.get("data"), str)
        and re.fullmatch(r"0x[0-9a-fA-F]{64}", log["data"])
        and int(log["data"], 16) == 866000
    ]) != 1:
        fail("Opening mint receipt lacks the exact main-account credit")
    configured = receipt("configureAgentWallet", expected_to=addresses["ecnySim"])
    configured_topic = "0xc5b405b8d912cd7016aa0318c05febe7708ec672827c4c970534d75d1bad4a48"
    wallet_topic = "0x" + addresses["agentWallet"].lower().removeprefix("0x").rjust(64, "0")
    configured_logs = configured.get("logs")
    if not isinstance(configured_logs, list) or len([
        log for log in configured_logs
        if isinstance(log, dict)
        and str(log.get("address", "")).lower() == addresses["ecnySim"].lower()
        and isinstance(log.get("topics"), list)
        and [str(topic).lower() for topic in log["topics"]] == [configured_topic, wallet_topic]
    ]) != 1:
        fail("Wallet configuration receipt lacks the configured destination")


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
    if process.poll() is not None:
        fail(f"{name} failed to start")
    started = ps(process.pid, "lstart") or dt.datetime.now(dt.timezone.utc).isoformat()
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


def build_workspace_package(name: str, location: Path, env: dict, extras: list[str] | None = None) -> str:
    sources = [
        location / "src",
        location / "package.json",
        location / "tsconfig.json",
        ROOT / "tsconfig.base.json",
        ROOT / "pnpm-lock.yaml",
    ]
    source_hash = fingerprint(sources, extras)
    output = location / "dist/index.js"
    marker = RUNTIME / f"{name}-build.sha256"
    if not output.is_file() or not marker.is_file() or marker.read_text().strip() != source_hash:
        run_build(name, [COREPACK, "pnpm", "--filter", f"@webank/{name}", "build"], ROOT, env)
        if not output.is_file():
            fail(f"{name} build did not produce dist/index.js")
        if fingerprint(sources, extras) != source_hash:
            fail(f"{name} sources changed during build; retry after edits finish")
        marker.write_text(source_hash + "\n")
    return source_hash


def prepare_builds() -> None:
    common = runtime_env()
    common["NEXT_TELEMETRY_DISABLED"] = "1"
    common["EXPO_NO_TELEMETRY"] = "1"
    contracts_hash = build_workspace_package("contracts", ROOT / "packages/contracts", common)
    build_workspace_package("chain", ROOT / "packages/chain", common)
    build_workspace_package("guardian", ROOT / "services/guardian", common, [contracts_hash])
    build_workspace_package("connector-mcp", ROOT / "agents/connector-mcp", common, [contracts_hash])
    shop_hash = fingerprint([SHOP / "app", SHOP / "lib", SHOP / "package.json"], [contracts_hash])
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


def read_guardian_env() -> dict[str, str]:
    path = RUNTIME / "guardian-hermes.env"
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except FileNotFoundError:
        return {}
    except OSError:
        fail("Private Guardian configuration is unsafe or unreadable")
    try:
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_nlink != 1
        ):
            fail("Private Guardian configuration has unsafe ownership or permissions")
        raw = os.read(descriptor, 8193)
        if len(raw) > 8192:
            fail("Private Guardian configuration is too large")
    finally:
        os.close(descriptor)
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        fail("Private Guardian configuration is malformed")
    if not content.endswith("\n") or "\r" in content or "\x00" in content:
        fail("Private Guardian configuration is malformed")
    allowed = {
        "WEBANK_GUARDIAN_HERMES_URL",
        "WEBANK_GUARDIAN_HERMES_KEY",
        "WEBANK_GUARDIAN_HERMES_PROFILE_VERIFIED",
        "WEBANK_GUARDIAN_HERMES_MODEL",
    }
    required = allowed - {"WEBANK_GUARDIAN_HERMES_MODEL"}
    values: dict[str, str] = {}
    for line in content.splitlines():
        name, separator, value = line.partition("=")
        if not separator or name not in allowed or name in values or not value:
            fail("Private Guardian configuration is malformed")
        values[name] = value
    if not required.issubset(values):
        fail("Private Guardian configuration is incomplete")
    try:
        url = urllib.parse.urlsplit(values["WEBANK_GUARDIAN_HERMES_URL"])
        port = url.port
    except ValueError:
        fail("Private Guardian configuration has an invalid endpoint")
    if (
        url.scheme != "http"
        or url.hostname != "127.0.0.1"
        or port is None
        or port < 1
        or url.netloc != f"127.0.0.1:{port}"
        or (url.path not in ("", "/") and not re.fullmatch(r"/p/[A-Za-z0-9_-]+/?", url.path))
        or url.query
        or url.fragment
    ):
        fail("Private Guardian configuration has an invalid endpoint")
    if not re.fullmatch(r"[0-9a-f]{64}", values["WEBANK_GUARDIAN_HERMES_KEY"]):
        fail("Private Guardian configuration has an invalid key")
    if values["WEBANK_GUARDIAN_HERMES_PROFILE_VERIFIED"] != "1":
        fail("Private Guardian profile audit is not confirmed")
    if "WEBANK_GUARDIAN_HERMES_MODEL" in values and not re.fullmatch(
        r"[A-Za-z0-9][A-Za-z0-9._/-]{0,127}", values["WEBANK_GUARDIAN_HERMES_MODEL"]
    ):
        fail("Private Guardian configuration has an invalid model")
    return values


def reset_sources() -> dict[str, Path]:
    return {
        "addresses": ADDRESSES,
        "gateway-state": GATEWAY_STATE,
        "gateway-initialized": Path(f"{GATEWAY_STATE}.initialized"),
        "gateway-identity": Path(f"{GATEWAY_STATE}.identity"),
        "gateway-identity-initialized": Path(f"{GATEWAY_STATE}.identity.initialized"),
        "shop-state": SHOP_STATE,
    }


def deployment_source_fingerprint() -> str:
    onchain = ROOT / "onchain"
    source_files = sorted((onchain / "src").glob("*.sol"))
    source_files.extend((onchain / "scripts" / name for name in ("compile.mjs", "deploy.ts")))
    source_files.append(onchain / "package.json")
    digest = hashlib.sha256()
    for path in source_files:
        digest.update(str(path.relative_to(onchain)).encode() + b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def verify_reset_quiescent(path: Path) -> None:
    envelope = json.loads(path.read_text())
    if not isinstance(envelope, dict) or envelope.get("version") != 1 or not isinstance(envelope.get("payload"), dict):
        fail("Gateway snapshot is incompatible; refusing fresh reset")
    payload = envelope["payload"]
    digest = hashlib.sha256(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    if envelope.get("sha256") != digest:
        fail("Gateway snapshot integrity check failed; refusing fresh reset")

    def records(name: str) -> list:
        if name in {"mandates", "approvals", "pairings", "payments"} and name not in payload:
            fail(f"Gateway {name} is missing; refusing fresh reset")
        value = payload.get(name, [])
        if not isinstance(value, list):
            fail(f"Gateway {name} is incompatible; refusing fresh reset")
        return value

    if records("replacingAgents"):
        fail("Resolve agent replacement before fresh reset")
    for name, terminal in (
        ("mandates", {"cancelled", "exhausted", "expired"}),
        ("pairings", {"approved", "denied", "consumed"}),
        ("payments", {"paid", "denied"}),
        ("fundingRecords", {"completed", "failed"}),
        ("sweepRecords", {"completed"}),
        ("humanPaymentRecords", {"completed", "failed"}),
    ):
        for item in records(name):
            if not isinstance(item, dict) or not isinstance(item.get("status"), str):
                fail(f"Gateway {name} is incompatible; refusing fresh reset")
            if item["status"] not in terminal:
                fail(f"Resolve {name} status {item['status']} before fresh reset")
            if name == "mandates" and item.get("in_flight_payment_id") is not None:
                fail("Resolve in-flight mandate payment before fresh reset")
    for item in records("approvals"):
        if not isinstance(item, list) or len(item) != 2 or not isinstance(item[1], dict):
            fail("Gateway approvals are incompatible; refusing fresh reset")
        card = item[1].get("card")
        if not isinstance(card, dict) or not isinstance(card.get("status"), str):
            fail("Gateway approvals are incompatible; refusing fresh reset")
        if card["status"] not in {"approved", "rejected", "expired"}:
            fail(f"Resolve approval status {card['status']} before fresh reset")
    funding_by_id = {item.get("fundingId"): item for item in records("fundingRecords")}
    for challenge in records("fundingChallenges"):
        if not isinstance(challenge, dict) or not isinstance(challenge.get("fundingId"), str) or not isinstance(challenge.get("consumed"), bool):
            fail("Gateway funding challenge is incompatible; refusing fresh reset")
        record = funding_by_id.get(challenge["fundingId"])
        if record is None or record["status"] not in {"completed", "failed"}:
            fail("Resolve funding challenge before fresh reset")


def acquire_reset_writer_lock() -> tuple[Path, int]:
    lock = Path(f"{GATEWAY_STATE}.lock")
    if Path(f"{GATEWAY_STATE}.identity.lock").exists():
        fail("Gateway identity has a writer lock; stop the Gateway before fresh reset")
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        fail("Gateway state has a writer lock; verify the Gateway is stopped before fresh reset")
    with os.fdopen(descriptor, "w") as output:
        output.write(str(os.getpid()))
        output.flush()
        os.fsync(output.fileno())
    return lock, lock.stat().st_ino


def release_reset_writer_lock(owned_lock: tuple[Path, int]) -> None:
    path, inode = owned_lock
    if path.stat().st_ino != inode or path.read_text() != str(os.getpid()):
        fail("Gateway reset writer lock ownership changed")
    path.unlink()
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def fresh_reset_journal(*, owns_writer_lock: bool = False) -> dict:
    if FRESH_RESET.is_file():
        if FRESH_RESET.stat().st_mode & 0o077:
            fail("Fresh reset journal has unsafe permissions")
        journal = json.loads(FRESH_RESET.read_text())
        if not isinstance(journal, dict) or journal.get("version") != 1:
            fail("Fresh reset journal is invalid; inspect it before recovery")
        if journal.get("phase") not in ("prepared", "archived"):
            fail("Fresh reset journal phase is invalid")
        if not isinstance(journal.get("id"), str) or not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}", journal["id"]):
            fail("Fresh reset journal archive ID is invalid")
        if not isinstance(journal.get("files"), dict) or set(journal["files"]) != set(reset_sources()):
            fail("Fresh reset journal file list is invalid")
        if any(value is not None and (not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)) for value in journal["files"].values()):
            fail("Fresh reset journal file hashes are invalid")
        if journal.get("sourceFingerprint") != deployment_source_fingerprint():
            fail("Fresh reset source changed since preparation; inspect before recovery")
        return journal
    if FRESH_PENDING.exists():
        fail("Orphan pending fresh deployment exists; inspect it before starting a new reset")
    locks = [Path(f"{GATEWAY_STATE}.lock"), Path(f"{GATEWAY_STATE}.identity.lock")]
    if not owns_writer_lock and any(path.exists() for path in locks):
        fail("Gateway state has a writer lock; verify the Gateway is stopped before --fresh")
    sources = reset_sources()
    gateway_present = [sources[name].is_file() for name in ("gateway-state", "gateway-initialized", "gateway-identity", "gateway-identity-initialized")]
    if any(gateway_present) and not all(gateway_present):
        fail("Gateway state and identity are incomplete; refusing --fresh archive")
    if any(gateway_present) and not ADDRESSES.is_file():
        fail("Prior chain address manifest is missing; refusing --fresh archive")
    if all(gateway_present):
        verify_reset_quiescent(GATEWAY_STATE)
    files = {}
    for name, path in sources.items():
        if path.exists() and not path.is_file():
            fail(f"Fresh reset source {name} is not a regular file")
        if path.is_file() and path.stat().st_mode & 0o077:
            fail(f"Fresh reset source {name} is not owner-only")
        files[name] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
    prior_wallet = None
    if ADDRESSES.is_file():
        prior = json.loads(ADDRESSES.read_text())
        if not isinstance(prior.get("deploymentFingerprint"), str) or not re.fullmatch(r"[0-9a-fA-F]{64}", prior["deploymentFingerprint"]):
            fail("Prior chain deployment fingerprint is missing or invalid")
        prior_wallet = prior.get("agentWallet")
        if not isinstance(prior_wallet, str) or not re.fullmatch(r"0x[0-9a-fA-F]{40}", prior_wallet):
            fail("Prior AgentWallet address is invalid")
    journal = {
        "version": 1,
        "id": dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(6),
        "phase": "prepared",
        "sourceFingerprint": deployment_source_fingerprint(),
        "files": files,
        "priorAgentWallet": prior_wallet,
    }
    write_private_json(FRESH_RESET, journal)
    return journal


def archive_fresh_inputs(journal: dict) -> Path:
    archive = RUNTIME / "fresh-reset-archives" / journal["id"]
    archive.mkdir(mode=0o700, parents=True, exist_ok=True)
    archive.chmod(0o700)
    if journal["phase"] == "prepared":
        for name, source in reset_sources().items():
            digest = journal["files"][name]
            destination = archive / name
            if digest is None:
                if destination.exists():
                    fail(f"Unexpected fresh reset archive entry: {name}")
                continue
            if destination.exists():
                if source.exists() or hashlib.sha256(destination.read_bytes()).hexdigest() != digest:
                    fail(f"Fresh reset archive conflict: {name}")
            elif source.is_file() and hashlib.sha256(source.read_bytes()).hexdigest() == digest:
                source.replace(destination)
            else:
                fail(f"Fresh reset source changed or disappeared: {name}")
            if destination.stat().st_mode & 0o077:
                fail(f"Fresh reset archive has unsafe permissions: {name}")
        for parent in {archive, *(path.parent for path in reset_sources().values())}:
            directory = os.open(parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        journal["phase"] = "archived"
        write_private_json(FRESH_RESET, journal)
        print(f"Archived previous demo inputs at {archive}")
    else:
        for name, digest in journal["files"].items():
            destination = archive / name
            if digest is not None and (not destination.is_file() or hashlib.sha256(destination.read_bytes()).hexdigest() != digest):
                fail(f"Fresh reset archive is incomplete: {name}")
    return archive


def up(fresh: bool) -> None:
    if STATE.exists():
        fail(f"A launcher state already exists; run {SCRIPTS / 'local-demo-down.sh'} first")
    if FRESH_RESET.exists() and not fresh:
        fail("Fresh reset is incomplete; resume with local-demo-up.sh --fresh after reviewing the private journal")
    if FUNDING_CUTOVER.exists():
        fail("Funding cutover is incomplete; resume migration before starting the local demo")
    if not NODE or not COREPACK:
        fail("Node 22 and Corepack are required; no dependency install will be attempted")
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
    print(f"Preflight: {free} bytes available; Node 22 at {NODE}; no project listener will be reused")
    prepare_builds()
    environment = runtime_env()
    state = {"version": 1, "children": {}, "chain_pids": {}, "created_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    write_state(state)
    old_keys = hashlib.sha256(SHOP_KEYS.read_bytes()).hexdigest() if SHOP_KEYS.is_file() else None
    shop_token = secrets.token_urlsafe(32)
    reset_lock = None
    try:
        if fresh:
            reset_lock = acquire_reset_writer_lock()
        journal = fresh_reset_journal(owns_writer_lock=True) if fresh else None
        if journal is not None:
            archive_fresh_inputs(journal)
        shop_env = {**environment, "SHOP_INTERNAL_TOKEN": shop_token, "NEXT_TELEMETRY_DISABLED": "1"}
        shop = start("shop", [NODE, str(SHOP / "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", "3001"], SHOP, shop_env, state)

        def shop_ready():
            status, body = request("http://127.0.0.1:3001/api/merchants")
            data = json.loads(body) if status == 200 else {}
            return status == 200 and data.get("simulated") is True and len(data.get("merchants", [])) == 4

        wait_ready("shop", shop, shop_ready)
        if old_keys and hashlib.sha256(SHOP_KEYS.read_bytes()).hexdigest() != old_keys:
            fail("Shop merchant keys changed unexpectedly")
        with log_file("chain-up.log") as output:
            result = subprocess.run(
                [str(SCRIPTS / "chain-up.sh"), "--merchants-url", "http://127.0.0.1:3001/api/merchants"],
                cwd=ROOT,
                env={**environment, **{name: str(path) for name, path in local_chain_artifacts.items()}},
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
        if fresh and (addresses.get("migration") is not None or not isinstance(addresses.get("txHashes"), dict) or set(addresses["txHashes"]) != NATIVE_FUNDED_TXS):
            fail("Fresh reset requires the complete native funded deployment manifest")
        staged = None
        if addresses.get("migration") is not None:
            if not FUNDING_STAGE.is_file() or FUNDING_STAGE.stat().st_mode & 0o077:
                fail("Private staged funding manifest is missing or has unsafe permissions")
            staged = json.loads(FUNDING_STAGE.read_text())
        verify_deployment_funding(addresses, staged)
        if journal and journal["priorAgentWallet"] == addresses.get("agentWallet"):
            fail("Fresh deployment reused the old AgentWallet address")
        if reset_lock is not None:
            release_reset_writer_lock(reset_lock)
            reset_lock = None
        gateway_env = {
            **environment,
            **read_gateway_env(),
            **read_guardian_env(),
            "WEBANK_LOCAL_DEMO": "1",
            "WEBANK_DEMO_APPROVALS": "1",
            "WEBANK_DEMO_APP_ORIGIN": "http://127.0.0.1:8081",
            "WEBANK_SHOP_URL": "http://127.0.0.1:3001",
            "WEBANK_LOCAL_DEMO_PORT": "3002",
            "WEBANK_GATEWAY_STATE_PATH": str(GATEWAY_STATE),
            "FISCO_RPC_URL": "http://127.0.0.1:8545",
            "SHOP_INTERNAL_TOKEN": shop_token,
            "WEBANK_LOCAL_DEMO_TOKEN_FILE": str(TOKEN),
        }
        TOKEN.unlink(missing_ok=True)
        gateway = start("gateway", [NODE, "--import", "tsx", "src/local-demo-server.ts"], GATEWAY, gateway_env, state)
        wait_ready("gateway", gateway, lambda: TOKEN.is_file() and request("http://127.0.0.1:3002/v1/app/agents")[0] == 401)
        app = start("app", [sys.executable, "-m", "http.server", "8081", "--bind", "127.0.0.1", "--directory", str(APP / "dist")], ROOT, environment, state)
        wait_ready("app", app, lambda: request("http://127.0.0.1:8081/")[0] == 200)
        if journal is not None:
            FRESH_RESET.unlink()
            directory = os.open(RUNTIME, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        print("SIMULATED local demo ready: http://127.0.0.1:8081")
        print("Shop: http://127.0.0.1:3001  Gateway: http://127.0.0.1:3002  FISCO RPC: http://127.0.0.1:8545")
        print(f"Private local app token: read {TOKEN} locally (mode 0600); it is not logged")
        print(f"Stop with: {SCRIPTS / 'local-demo-down.sh'}")
    except BaseException:
        try:
            if reset_lock is not None:
                release_reset_writer_lock(reset_lock)
        finally:
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
