import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ClientAppNameSchema } from "@webank/contracts";

export interface PendingPairing {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  qrPayload: string;
  requestNumber: string;
  expiresAt: number;
  interval: number;
}

export interface Credentials {
  privateKeyPem: string;
  publicKey: string;
  agentId?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  pending?: PendingPairing;
  /** An unverified prior key retained during explicit, owner-approved recovery. */
  quarantined?: Omit<Credentials, "pending" | "quarantined">;
}

export interface CredentialStore {
  load(): Promise<Credentials | null>;
  save(credentials: Credentials): Promise<void>;
  clear?(): Promise<void>;
}

export interface ClientAppIdentity {
  id: string;
  name: string;
}

export function clientAppIdentity(name: unknown): ClientAppIdentity {
  const parsed = ClientAppNameSchema.safeParse(name);
  if (!parsed.success) {
    throw new Error("Valid MCP initialize clientInfo.name is required");
  }
  return {
    id: `app_${createHash("sha256").update(parsed.data, "utf8").digest("hex")}`,
    name: parsed.data,
  };
}

export class FileCredentialStore implements CredentialStore {
  constructor(
    readonly path = join(
      homedir(),
      ".config",
      "webank-agent-wallet",
      "connector.json",
    ),
  ) {}

  forApp(app: ClientAppIdentity): FileCredentialStore {
    if (!/^app_[0-9a-f]{64}$/.test(app.id)) {
      throw new Error("Invalid client app credential namespace");
    }
    return new FileCredentialStore(
      join(dirname(this.path), "apps", `${app.id}.json`),
    );
  }

  async load(): Promise<Credentials | null> {
    try {
      const directory = await lstat(dirname(this.path));
      if (!directory.isDirectory() || directory.mode & 0o077) {
        throw new Error(
          "Connector credential directory has unsafe permissions",
        );
      }
      const stat = await lstat(this.path);
      if (!stat.isFile() || stat.mode & 0o077) {
        throw new Error("Connector credential file has unsafe permissions");
      }
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (
        !value ||
        typeof value !== "object" ||
        typeof (value as Credentials).privateKeyPem !== "string" ||
        typeof (value as Credentials).publicKey !== "string"
      ) {
        throw new Error("Connector credential file is invalid");
      }
      return value as Credentials;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(credentials: Credentials): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.mode & 0o077) {
      throw new Error("Connector credential directory has unsafe permissions");
    }
    const temp = join(directory, `.connector-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(credentials), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temp, this.path);
    } catch (error) {
      const { unlink } = await import("node:fs/promises");
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  async clear(): Promise<void> {
    await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
