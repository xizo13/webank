import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

type Envelope<T> = { version: 1; payload: T; sha256: string };

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Small, single-writer, owner-only local demo store. An ambiguous write fails closed. */
export class DurableState<T> {
  private readonly lockPath: string;
  private readonly initializedPath: string;
  private closed = false;
  private ambiguous = false;

  constructor(private readonly path: string) {
    if (!isAbsolute(path))
      throw new Error("Gateway state path must be absolute");
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if ((statSync(directory).mode & 0o077) !== 0)
      throw new Error("Gateway state directory is not owner-only");
    this.lockPath = `${path}.lock`;
    this.initializedPath = `${path}.initialized`;
    if (existsSync(this.initializedPath) && !existsSync(path))
      throw new Error("Gateway state is missing after prior initialization");
    if (existsSync(this.lockPath)) {
      let pid = 0;
      try {
        pid = Number(readFileSync(this.lockPath, "utf8"));
      } catch {
        throw new Error("Gateway state lock is unreadable");
      }
      if (!Number.isInteger(pid) || pid < 1)
        throw new Error("Gateway state lock is invalid");
      try {
        process.kill(pid, 0);
        throw new Error("Gateway state already has an active writer");
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure;
      }
      throw new Error(
        "Gateway state has a stale writer lock; verify the old process is stopped, then remove the lock manually",
      );
    }
    const descriptor = openSync(this.lockPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, String(process.pid));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  get isAmbiguous(): boolean {
    return this.ambiguous;
  }

  load(): T | null {
    if (!existsSync(this.path)) return null;
    if ((statSync(this.path).mode & 0o077) !== 0)
      throw new Error("Gateway state file is not owner-only");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      throw new Error("Gateway state is unreadable or corrupt");
    }
    const item = raw as Partial<Envelope<T>>;
    if (
      item?.version !== 1 ||
      !item.payload ||
      typeof item.sha256 !== "string" ||
      digest(item.payload) !== item.sha256
    )
      throw new Error("Gateway state is incompatible or corrupt");
    return item.payload;
  }

  save(payload: T): void {
    if (this.closed) throw new Error("Gateway state writer is closed");
    if (this.ambiguous)
      throw new Error(
        "Gateway state write was ambiguous; restart to reconcile from disk",
      );
    const temporary = join(
      dirname(this.path),
      `.${basename(this.path)}.${process.pid}.tmp`,
    );
    const envelope: Envelope<T> = {
      version: 1,
      payload,
      sha256: digest(payload),
    };
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(envelope)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.path);
    this.ambiguous = true;
    if (!existsSync(this.initializedPath)) {
      const marker = openSync(this.initializedPath, "wx", 0o600);
      try {
        writeFileSync(marker, "1\n");
        fsyncSync(marker);
      } finally {
        closeSync(marker);
      }
    }
    const directory = openSync(dirname(this.path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    this.ambiguous = false;
  }

  close(): void {
    if (this.closed) return;
    if (readFileSync(this.lockPath, "utf8") !== String(process.pid))
      throw new Error("Gateway state lock ownership changed");
    unlinkSync(this.lockPath);
    this.closed = true;
  }
}
