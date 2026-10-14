#!/usr/bin/env python3
"""Build and operate the local FISCO BCOS demo chain without exposing listeners."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CHAIN_DIR = Path(__file__).resolve().parent
RUNTIME = CHAIN_DIR / "runtime"
NODES = RUNTIME / "nodes" / "127.0.0.1"
ONCHAIN = ROOT / "onchain"
ADDRESSES = CHAIN_DIR / "addresses.json"
PIDS = RUNTIME / "pids.json"
RPC_URL = "http://127.0.0.1:8545"
VERSION = "v3.17.1"
ARCHIVE_SHA256 = "9c7a7524b43f2f2354b0aacd32b921caeafc3472837d16b3bccd164a5bd1a4f4"
BINARY_SHA256 = "61ca196b30872d1d0070381b05fedb718ac038303690bb319b8f15aaa7223495"
BUILDER_SHA256 = "ed667e1e346acbe2fea7b667856ddf05af9e4892ac0424ff9f703f0ea601dbe7"
TASSL_SHA256 = "09096906d279451544b14fd14192cfaed6584e56e947d44dae2f50bcfa135885"
ACCOUNT_HELPER_SHA256 = "b5ed2b5ab820098b26ffa7168c001502ceeac83c76566b5de0da3474c935d6dc"
ARCHIVE_URL = "https://github.com/FISCO-BCOS/FISCO-BCOS/releases/download/v3.17.1/fisco-bcos-macOS-arm.tar.gz"
BUILDER_URL = "https://raw.githubusercontent.com/FISCO-BCOS/FISCO-BCOS/v3.17.1/tools/BcosAirBuilder/build_chain.sh"
TASSL_URL = "https://github.com/FISCO-BCOS/TASSL/releases/download/V_1.4/tassl-1.1.1b-macOS-aarch64.tar.gz"
ACCOUNT_HELPER_URL = "https://raw.githubusercontent.com/FISCO-BCOS/console/master/tools/get_account.sh"
PORTS = (30300, 30301, 30302, 30303, 20200, 20201, 20202, 20203, 8545)


def say(message: str) -> None:
    print(message, flush=True)


def fail(message: str) -> None:
    raise RuntimeError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verified_copy_or_download(destination: Path, expected: str, url: str, source_env: str) -> None:
    if destination.is_file() and sha256(destination) == expected:
        return
    source = os.environ.get(source_env)
    temporary = destination.with_name(destination.name + ".partial")
    if source:
        candidate = Path(source).expanduser().resolve()
        if not candidate.is_file():
            fail(f"{source_env} does not name a file: {candidate}")
        shutil.copyfile(candidate, temporary)
    else:
        say(f"Downloading {destination.name} from the pinned official release")
        subprocess.run(
            ["curl", "-fL", "--retry", "3", "--connect-timeout", "20", "--max-time", "180", "-o", str(temporary), url],
            check=True,
        )
    if sha256(temporary) != expected:
        temporary.unlink(missing_ok=True)
        fail(f"SHA-256 mismatch for {destination.name}")
    temporary.replace(destination)


def extract_verified_member(archive: Path, member_name: str, destination: Path, expected: str) -> None:
    with tarfile.open(archive, "r:gz") as bundle:
        candidates = [member for member in bundle.getmembers() if Path(member.name).name == member_name and member.isfile()]
        if len(candidates) != 1:
            fail(f"Expected one {member_name} in {archive.name}")
        source = bundle.extractfile(candidates[0])
        if source is None:
            fail(f"Cannot extract {member_name}")
        temporary = destination.with_name(destination.name + ".partial")
        with temporary.open("wb") as output:
            shutil.copyfileobj(source, output)
        if sha256(temporary) != expected:
            temporary.unlink(missing_ok=True)
            fail(f"SHA-256 mismatch for {member_name}")
        temporary.chmod(0o700)
        temporary.replace(destination)


def prepare_builder() -> tuple[Path, Path]:
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        fail("This pinned FISCO v3.17.1 runner supports macOS arm64 only")
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    RUNTIME.chmod(0o700)
    helper_home = RUNTIME / "home" / ".fisco"
    helper_home.mkdir(mode=0o700, parents=True, exist_ok=True)
    helper_home.chmod(0o700)
    archive = RUNTIME / "fisco-bcos-v3.17.1-macOS-arm.tar.gz"
    binary = RUNTIME / "fisco-bcos"
    builder = RUNTIME / "build_chain.sh"
    tassl = RUNTIME / "home" / ".fisco" / "tassl-1.1.1b"
    account_helper = RUNTIME / "home" / ".fisco" / "get_account.sh"
    verified_copy_or_download(archive, ARCHIVE_SHA256, ARCHIVE_URL, "FISCO_ARCHIVE_FILE")
    if not binary.is_file() or sha256(binary) != BINARY_SHA256:
        extract_verified_member(archive, "fisco-bcos", binary, BINARY_SHA256)
    verified_copy_or_download(builder, BUILDER_SHA256, BUILDER_URL, "FISCO_BUILDER_FILE")
    if not tassl.is_file() or sha256(tassl) != TASSL_SHA256:
        tassl_archive = RUNTIME / "tassl-1.1.1b-macOS-aarch64.tar.gz"
        supplied = os.environ.get("FISCO_TASSL_BINARY")
        if supplied:
            candidate = Path(supplied).expanduser().resolve()
            if not candidate.is_file() or sha256(candidate) != TASSL_SHA256:
                fail("FISCO_TASSL_BINARY is missing or failed SHA-256 verification")
            shutil.copyfile(candidate, tassl)
            tassl.chmod(0o700)
        else:
            # The tagged Air builder otherwise downloads this helper itself.
            say("Downloading the pinned TASSL helper")
            subprocess.run(
                ["curl", "-fL", "--retry", "3", "--connect-timeout", "20", "--max-time", "180", "-o", str(tassl_archive), TASSL_URL],
                check=True,
            )
            extract_verified_member(tassl_archive, "tassl-1.1.1b-macOS-aarch64", tassl, TASSL_SHA256)
    verified_copy_or_download(
        account_helper,
        ACCOUNT_HELPER_SHA256,
        ACCOUNT_HELPER_URL,
        "FISCO_ACCOUNT_HELPER_FILE",
    )
    return binary, builder


def rewrite_ini(path: Path, node_number: int) -> None:
    section = ""
    seen: set[tuple[str, str]] = set()
    lines = []
    for line in path.read_text().splitlines(keepends=True):
        section_match = re.match(r"\s*\[([^]]+)\]", line)
        if section_match:
            section = section_match.group(1)
        key_match = re.match(r"(\s*)(listen_ip|listen_port|enable|enable_cors)\s*=.*", line)
        if key_match and section in ("p2p", "rpc", "web3_rpc"):
            key = key_match.group(2)
            value = None
            if key == "listen_ip":
                value = "127.0.0.1"
            elif section == "web3_rpc" and key == "listen_port":
                value = "8545"
            elif section == "web3_rpc" and key == "enable":
                value = "true" if node_number == 0 else "false"
            elif section == "web3_rpc" and key == "enable_cors":
                value = "false"
            if value is not None:
                line = f"{key_match.group(1)}{key}={value}\n"
                seen.add((section, key))
        lines.append(line)
    required = {("p2p", "listen_ip"), ("rpc", "listen_ip"), ("web3_rpc", "listen_ip"),
                ("web3_rpc", "listen_port"), ("web3_rpc", "enable")}
    if required - seen:
        fail(f"Unexpected FISCO config shape at {path}: missing {sorted(required - seen)}")
    path.write_text("".join(lines))


def build_nodes(binary: Path, builder: Path) -> None:
    if NODES.is_dir():
        return
    output = RUNTIME / "nodes-building"
    if output.exists():
        shutil.rmtree(output)
    env = os.environ.copy()
    env["HOME"] = str(RUNTIME / "home")
    say("Building four non-SM FISCO BCOS nodes")
    subprocess.run(
        ["bash", str(builder), "-v", VERSION, "-p", "30300,20200", "-l", "127.0.0.1:4", "-o", str(output), "-e", str(binary)],
        cwd=RUNTIME,
        env=env,
        check=True,
    )
    built = output / "127.0.0.1"
    for number in range(4):
        node = built / f"node{number}"
        genesis = (node / "config.genesis").read_text()
        if not re.search(r"(?m)^\s*sm_crypto=false\s*$", genesis):
            fail(f"node{number} is not configured for non-SM mode")
        if not re.search(r"(?m)^\s*chain_id=20200\s*$", genesis):
            fail(f"node{number} has unexpected Web3 chain ID")
        rewrite_ini(node / "config.ini", number)
    copied_binary = built / "fisco-bcos"
    if sha256(copied_binary) != BINARY_SHA256:
        fail("Node binary differs from pinned FISCO release")
    output.rename(RUNTIME / "nodes")


def read_keys() -> tuple[str, str, str]:
    bank_file = RUNTIME / "bank.env"
    gateway_file = RUNTIME / "gateway.env"
    if bank_file.exists() != gateway_file.exists():
        fail("Only one signer file exists; restore the missing file before starting")
    if not bank_file.exists():
        bank_key = "0x" + secrets.token_hex(32)
        gateway_key = "0x" + secrets.token_hex(32)
        bank_file.write_text(f"FISCO_BANK_PRIVATE_KEY={bank_key}\n")
        gateway_file.write_text(f"FISCO_GATEWAY_PRIVATE_KEY={gateway_key}\nFISCO_PRIVATE_KEY={gateway_key}\n")
        bank_file.chmod(0o600)
        gateway_file.chmod(0o600)
        say(f"Generated separate local bank and Gateway signers under {RUNTIME}")
    for key_file in (bank_file, gateway_file):
        if stat.S_IMODE(key_file.stat().st_mode) & 0o077:
            fail(f"Signer file is readable by other users: {key_file}")
    bank_key = bank_file.read_text().split("=", 1)[1].splitlines()[0]
    gateway_key = gateway_file.read_text().split("=", 1)[1].splitlines()[0]
    if not re.fullmatch(r"0x[0-9a-fA-F]{64}", bank_key) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", gateway_key):
        fail("Invalid local signer file")
    if bank_key == gateway_key:
        fail("Bank and Gateway signers must be distinct")
    address_script = "import { privateKeyToAccount } from 'viem/accounts'; console.log(privateKeyToAccount(process.env.KEY).address)"
    gateway_address = subprocess.check_output(
        ["node", "--input-type=module", "-e", address_script],
        cwd=ONCHAIN,
        env={**os.environ, "KEY": gateway_key},
        text=True,
    ).strip()
    return bank_key, gateway_key, gateway_address


def pid_command(pid: int) -> str:
    result = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else ""


def is_our_node(pid: int) -> bool:
    command = pid_command(pid)
    return str(NODES / "fisco-bcos") in command and "-c config.ini -g config.genesis" in command


def read_pids() -> dict[str, int]:
    if not PIDS.is_file():
        return {}
    data = json.loads(PIDS.read_text())
    if not isinstance(data, dict) or any(not isinstance(value, int) for value in data.values()):
        fail("Invalid local node PID file")
    return data


def rpc(method: str, params: list | None = None) -> object:
    request = urllib.request.Request(
        RPC_URL,
        data=json.dumps({"jsonrpc": "2.0", "method": method, "params": params or [], "id": 1}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        result = json.load(response)
    if "error" in result:
        fail(f"Web3 RPC {method} returned {result['error']}")
    return result["result"]


def wait_for_rpc(pids: dict[str, int], seconds: int = 45) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        dead = [node for node, pid in pids.items() if not is_our_node(pid)]
        if dead:
            fail(f"FISCO nodes exited during startup: {', '.join(dead)}")
        try:
            if rpc("eth_chainId") == "0x4ee8":
                return
        except (OSError, urllib.error.URLError, TimeoutError):
            pass
        time.sleep(1)
    fail("Web3 RPC did not become healthy within 45 seconds")


def listener_addresses(port: int) -> list[str]:
    result = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"], capture_output=True, text=True
    )
    if result.returncode not in (0, 1):
        fail(f"Cannot inspect TCP port {port}: {result.stderr.strip()}")
    return [line.split()[-2] for line in result.stdout.splitlines()[1:] if "(LISTEN)" in line]


def verify_listeners() -> None:
    for port in PORTS:
        addresses = listener_addresses(port)
        if len(addresses) != 1 or addresses[0] != f"127.0.0.1:{port}":
            fail(f"Port {port} is not bound exclusively to loopback: {addresses}")


def start_nodes() -> dict[str, int]:
    existing = read_pids()
    if existing:
        if len(existing) != 4 or not all(is_our_node(pid) for pid in existing.values()):
            fail("PID file exists but the expected four nodes are not running; run chain-down.sh")
        wait_for_rpc(existing)
        verify_listeners()
        say("Existing four-node FISCO chain is healthy")
        return existing
    busy = {port: listener_addresses(port) for port in PORTS if listener_addresses(port)}
    if busy:
        fail(f"FISCO ports are already in use: {busy}")
    binary = NODES / "fisco-bcos"
    if sha256(binary) != BINARY_SHA256:
        fail("Node binary differs from pinned FISCO release")
    pids: dict[str, int] = {}
    try:
        for number in range(4):
            node = NODES / f"node{number}"
            with (node / "operator.log").open("ab") as log:
                process = subprocess.Popen(
                    [str(binary), "-c", "config.ini", "-g", "config.genesis"],
                    cwd=node,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    env={**os.environ, "RUST_LOG": "bcos_wasm=error"},
                )
            pids[f"node{number}"] = process.pid
        PIDS.write_text(json.dumps(pids, indent=2) + "\n")
        wait_for_rpc(pids)
        verify_listeners()
    except Exception:
        stop_nodes(pids)
        raise
    say("Four nodes healthy; Web3 RPC 127.0.0.1:8545; chain ID 20200; all listeners loopback")
    return pids


def stop_nodes(pids: dict[str, int] | None = None) -> None:
    pids = pids if pids is not None else read_pids()
    for pid in pids.values():
        if is_our_node(pid):
            os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline and any(is_our_node(pid) for pid in pids.values()):
        time.sleep(0.5)
    for pid in pids.values():
        if is_our_node(pid):
            os.kill(pid, signal.SIGKILL)
    PIDS.unlink(missing_ok=True)
    if pids:
        say("Stopped local FISCO nodes")
    else:
        say("No local FISCO nodes were running")


def ensure_dependencies() -> None:
    if (ONCHAIN / "node_modules" / "solc").exists():
        return
    say("Installing pinned pnpm workspace dependencies")
    subprocess.run(["corepack", "pnpm", "install", "--frozen-lockfile"], cwd=ROOT, check=True)


def deployment_fingerprint() -> str:
    """Bind reusable local addresses to the contract source and deploy settings."""
    source_files = sorted((ONCHAIN / "src").glob("*.sol"))
    source_files.extend((ONCHAIN / "scripts" / name for name in ("compile.mjs", "deploy.ts")))
    source_files.append(ONCHAIN / "package.json")
    digest = hashlib.sha256()
    for path in source_files:
        digest.update(str(path.relative_to(ONCHAIN)).encode() + b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def deploy_and_seed(bank_key: str, gateway_address: str, merchants: Path | None) -> None:
    env = {**os.environ, "FISCO_BANK_PRIVATE_KEY": bank_key, "FISCO_GATEWAY_ADDRESS": gateway_address,
           "FISCO_DEPLOY_OUTPUT": str(ADDRESSES), "FISCO_RPC_URL": RPC_URL}
    fingerprint = deployment_fingerprint()
    deploy = True
    if ADDRESSES.is_file():
        current = json.loads(ADDRESSES.read_text())
        address_fields = ("ecnySim", "merchantRegistry", "licenceRegistry", "auditAnchor", "agentWallet")
        if (current.get("chainId") == 20200
                and current.get("gateway", "").lower() == gateway_address.lower()
                and current.get("deploymentFingerprint") == fingerprint
                and all(isinstance(current.get(field), str) for field in address_fields)):
            deploy = any(
                rpc("eth_getCode", [current[field], "latest"]) in (None, "0x")
                for field in address_fields
            )
    if deploy:
        say("Deploying five demo contracts with the bank signer")
        subprocess.run(["corepack", "pnpm", "--filter", "@webank/onchain", "run", "deploy"], cwd=ROOT, env=env, check=True)
        deployed = json.loads(ADDRESSES.read_text())
        deployed["deploymentFingerprint"] = fingerprint
        temporary = ADDRESSES.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(deployed, indent=2) + "\n")
        temporary.chmod(0o600)
        temporary.replace(ADDRESSES)
    else:
        say(f"Using deployed contracts from {ADDRESSES}")
    ADDRESSES.chmod(0o600)
    if merchants:
        config = json.loads(ADDRESSES.read_text())
        env["FISCO_MERCHANT_REGISTRY_ADDRESS"] = config["merchantRegistry"]
        env["FISCO_MERCHANTS_FILE"] = str(merchants)
        say(f"Seeding mock merchants from {merchants}")
        subprocess.run(["corepack", "pnpm", "--filter", "@webank/onchain", "run", "seed:merchants"], cwd=ROOT, env=env, check=True)


def merchant_file(args: argparse.Namespace) -> Path | None:
    if args.merchants_file and args.merchants_url:
        fail("Choose either --merchants-file or --merchants-url")
    if args.merchants_file:
        path = Path(args.merchants_file).expanduser().resolve()
        if not path.is_file():
            fail(f"Merchant file does not exist: {path}")
        return path
    if args.merchants_url:
        from urllib.parse import urlparse

        parsed = urlparse(args.merchants_url)
        if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost"):
            fail("Merchant seed URL must use local HTTP on 127.0.0.1")
        path = CHAIN_DIR / "merchants.json"
        with urllib.request.urlopen(args.merchants_url, timeout=10) as response:
            payload = response.read(1024 * 1024 + 1)
        if len(payload) > 1024 * 1024:
            fail("Merchant seed response is too large")
        json.loads(payload)
        path.write_bytes(payload)
        return path
    return None


def up(args: argparse.Namespace) -> None:
    binary, builder = prepare_builder()
    build_nodes(binary, builder)
    ensure_dependencies()
    bank_key, _gateway_key, gateway_address = read_keys()
    merchants = merchant_file(args)
    start_nodes()
    deploy_and_seed(bank_key, gateway_address, merchants)
    say(f"Address config: {ADDRESSES}")
    say(f"Gateway signer environment: {RUNTIME / 'gateway.env'}")
    say("The bank signer stays in a separate ignored file")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    up_parser = commands.add_parser("up", help="Start or resume the local FISCO chain and deploy contracts")
    up_parser.add_argument("--merchants-file", help="Shop /api/merchants JSON saved locally")
    up_parser.add_argument("--merchants-url", help="Local shop /api/merchants URL")
    commands.add_parser("down", help="Stop only the nodes started by this script")
    args = parser.parse_args()
    if args.command == "up":
        up(args)
    else:
        stop_nodes()


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        print(f"chain {sys.argv[1] if len(sys.argv) > 1 else 'operation'} failed: {error}", file=sys.stderr)
        sys.exit(1)
