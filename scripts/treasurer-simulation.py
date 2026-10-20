#!/usr/bin/env python3
"""Append fixed, display-only Treasurer scenes to the local Bank Console."""

import argparse
import datetime as dt
import fcntl
import json
import os
import stat
from pathlib import Path

RUNTIME = Path(__file__).resolve().parent / "local-demo-runtime"


def events(scene: str, amount_fen: int | None, at: str) -> list[dict]:
    if scene == "renewal":
        if amount_fen is None or not 1 <= amount_fen <= 1_000_000:
            raise ValueError("Renewal simulation needs an exact amount from 1 to 1,000,000 fen")
        names = ("treasurer_renewal_reserved", "treasurer_renewal_paid")
    elif scene == "poisoned-topup":
        if amount_fen is not None:
            raise ValueError("The poisoned top-up simulation has a fixed ¥2,000 amount")
        names = ("treasurer_topup_blocked",)
        amount_fen = 200_000
    else:
        raise ValueError("Unknown Treasurer simulation scene")
    return [
        {
            "schema": "console_simulation.v1",
            "scene": name,
            "at": at,
            "amount_fen": amount_fen,
        }
        for name in names
    ]


def append_events(runtime: Path, values: list[dict]) -> None:
    metadata = runtime.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise RuntimeError("Local demo runtime must be an owner-only directory")
    lock_flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    lock_descriptor = os.open(runtime / "operator.lock", lock_flags, 0o600)
    with os.fdopen(lock_descriptor, "r+") as lock:
        lock_info = os.fstat(lock.fileno())
        if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_uid != os.getuid() or lock_info.st_mode & 0o077:
            raise RuntimeError("Operator lock must be an owner-only regular file")
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = runtime / "console-simulation.jsonl"
        flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags, 0o600)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise RuntimeError("Console simulation file must be an owner-only regular file")
            for value in values:
                remaining = memoryview((json.dumps(value, separators=(",", ":")) + "\n").encode())
                while remaining:
                    written = os.write(descriptor, remaining)
                    if written <= 0:
                        raise OSError("Console simulation write did not advance")
                    remaining = remaining[written:]
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scene", choices=("renewal", "poisoned-topup"))
    parser.add_argument("--amount-fen", type=int)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    at = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    values = events(args.scene, args.amount_fen, at)
    if not args.dry_run:
        append_events(RUNTIME, values)
    print(f"SIMULATION · Treasurer · {args.scene}: {len(values)} display-only event(s)")
    if args.dry_run:
        print("Dry run only; Bank Console was not changed")
    else:
        print("Bank Console display updated; no funding, payment, audit, or policy action occurred")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        raise SystemExit(f"Treasurer simulation failed: {error}") from None
