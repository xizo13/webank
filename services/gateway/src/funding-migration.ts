import { createHash, randomUUID } from "node:crypto";
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
import { dirname, join, resolve, sep } from "node:path";

type Deployment = {
  chainId: number;
  rpcUrl: string;
  bank: string;
  gateway: string;
  ecnySim: string;
  agentWallet: string;
  merchantRegistry: string;
  licenceRegistry: string;
  auditAnchor: string;
  deploymentFingerprint: string;
  migration?: {
    state: string;
    priorAddresses: { ecnySim: string; agentWallet: string };
    priorDeploymentFingerprint: string;
    priorReceiptHash?: string;
  };
};
type Envelope = {
  version: 1;
  payload: Record<string, unknown>;
  sha256: string;
};
type Marker = {
  version: 1;
  phase: "prepared" | "frozen" | "state_written" | "addresses_written";
  backupDir: string;
  oldHash: string;
  stagedHash: string;
  stateHash: string;
  identityHash: string;
};

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fileHash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
function ownerFile(path: string): void {
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error("Migration input is not an owner-only regular file");
}
function readEnvelope(path: string): Envelope {
  ownerFile(path);
  const value = JSON.parse(readFileSync(path, "utf8")) as Envelope;
  if (
    value.version !== 1 ||
    !value.payload ||
    digest(value.payload) !== value.sha256
  )
    throw new Error("Gateway state is corrupt or incompatible");
  return value;
}
function writeAtomic(path: string, text: string): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
function readDeployment(path: string): Deployment {
  ownerFile(path);
  return JSON.parse(readFileSync(path, "utf8")) as Deployment;
}
function blockedState(payload: Record<string, unknown>): string | null {
  const records = <T>(name: string): T[] => {
    const value = payload[name];
    if (!Array.isArray(value))
      throw new Error(`Gateway ${name} is incompatible`);
    return value as T[];
  };
  if (((payload.replacingAgents ?? []) as string[]).length > 0)
    return "unresolved agent replacement";
  if (
    records<{ status: string }>("mandates").some(
      (item) => item.status === "active",
    )
  )
    return "active mandate";
  if (
    records<[string, { card: { status: string } }]>("approvals").some(
      ([, item]) => item.card.status === "pending",
    )
  )
    return "pending approval";
  if (
    records<{ status: string }>("pairings").some(
      (item) => item.status === "pending" || item.status === "processing",
    )
  )
    return "pending pairing";
  if (
    records<{ status: string }>("payments").some((item) =>
      ["awaiting_user", "settling", "reconciliation_required"].includes(
        item.status,
      ),
    )
  )
    return "pending or uncertain payment";
  const fundingRecords = (payload.fundingRecords ?? []) as Array<{
    fundingId: string;
    status: string;
  }>;
  const fundingChallenges = (payload.fundingChallenges ?? []) as Array<{
    fundingId: string;
    expiresAt: number;
    consumed: boolean;
  }>;
  const fundingKeys = (payload.fundingKeys ?? []) as Array<
    [string, { fundingId: string }]
  >;
  if (
    fundingRecords.some((item) => {
      if (item.status === "completed" || item.status === "failed") return false;
      if (item.status !== "prepared") return true;
      const challenges = fundingChallenges.filter(
        (challenge) => challenge.fundingId === item.fundingId,
      );
      return (
        challenges.length !== 1 ||
        !challenges[0] ||
        challenges[0].consumed ||
        !Number.isSafeInteger(challenges[0].expiresAt) ||
        challenges[0].expiresAt > Date.now() ||
        fundingKeys.some(([, value]) => value.fundingId === item.fundingId)
      );
    })
  )
    return "pending or uncertain funding";
  if (
    ((payload.sweepRecords ?? []) as Array<{ status: string }>).some(
      (item) => item.status !== "completed",
    )
  )
    return "pending or uncertain sweep";
  return null;
}

type MigrationInput = {
  activePath: string;
  stagedPath: string;
  statePath: string;
  identityPath: string;
  markerPath: string;
  archiveDir: string;
  verifyOldPaid(wallet: string, receiptHash: string): Promise<boolean>;
  verifyStaged(deployment: Deployment): Promise<boolean>;
  freezeOldWallet(wallet: string): Promise<void>;
};

/** Explicit, resumable file cutover. The caller proves chain facts and freezes the old wallet. */
export async function migrateFundingDeployment(
  input: MigrationInput,
): Promise<{ backupDir: string; activeDeployment: Deployment }> {
  if (existsSync(`${input.identityPath}.lock`))
    throw new Error(
      "Gateway identity writer lock exists; stop the local demo first",
    );
  const lockPath = `${input.statePath}.lock`;
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Gateway writer lock exists; stop the local demo first");
    throw failure;
  }
  try {
    writeFileSync(descriptor, String(process.pid));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const lockInode = statSync(lockPath).ino;
  let result: { backupDir: string; activeDeployment: Deployment } | undefined;
  let operationFailure: unknown;
  try {
    result = await migrateFundingDeploymentLocked(input);
  } catch (failure) {
    operationFailure = failure;
  }
  if (
    statSync(lockPath).ino !== lockInode ||
    readFileSync(lockPath, "utf8") !== String(process.pid)
  )
    throw new Error("Funding migration writer lock ownership changed");
  unlinkSync(lockPath);
  if (operationFailure) throw operationFailure;
  if (!result) throw new Error("Funding migration returned no result");
  return result;
}

async function migrateFundingDeploymentLocked(
  input: MigrationInput,
): Promise<{ backupDir: string; activeDeployment: Deployment }> {
  const staged = readDeployment(input.stagedPath);
  const stagedHash = fileHash(input.stagedPath);
  let marker: Marker | undefined;
  if (existsSync(input.markerPath)) {
    ownerFile(input.markerPath);
    marker = JSON.parse(readFileSync(input.markerPath, "utf8")) as Marker;
    const archiveRoot = resolve(input.archiveDir);
    if (
      marker.version !== 1 ||
      marker.stagedHash !== stagedHash ||
      !["prepared", "frozen", "state_written", "addresses_written"].includes(
        marker.phase,
      ) ||
      !resolve(marker.backupDir).startsWith(`${archiveRoot}${sep}`)
    )
      throw new Error("Cutover marker is incompatible with staged deployment");
  }
  const active = readDeployment(
    marker ? join(marker.backupDir, "addresses.json") : input.activePath,
  );
  if (
    staged.migration?.state !== "staged" ||
    !/^0x[0-9a-fA-F]{64}$/.test(staged.migration.priorReceiptHash ?? "") ||
    staged.chainId !== 20200 ||
    staged.rpcUrl !== "http://127.0.0.1:8545" ||
    staged.bank.toLowerCase() !== active.bank.toLowerCase() ||
    staged.gateway.toLowerCase() !== active.gateway.toLowerCase() ||
    staged.merchantRegistry.toLowerCase() !==
      active.merchantRegistry.toLowerCase() ||
    staged.licenceRegistry.toLowerCase() !==
      active.licenceRegistry.toLowerCase() ||
    staged.auditAnchor.toLowerCase() !== active.auditAnchor.toLowerCase() ||
    staged.migration.priorAddresses.ecnySim.toLowerCase() !==
      active.ecnySim.toLowerCase() ||
    staged.migration.priorAddresses.agentWallet.toLowerCase() !==
      active.agentWallet.toLowerCase() ||
    staged.migration.priorDeploymentFingerprint !== active.deploymentFingerprint
  )
    throw new Error("Staged deployment does not match the active history");
  const stagedMigration = staged.migration;
  if (!stagedMigration?.priorReceiptHash)
    throw new Error("Staged deployment has no prior receipt proof");
  if (!marker) {
    const oldHash = fileHash(input.activePath);
    const envelope = readEnvelope(input.statePath);
    ownerFile(input.identityPath);
    if (envelope.payload.context !== JSON.stringify(active))
      throw new Error("Gateway state belongs to another deployment");
    const blocked = blockedState(envelope.payload);
    if (blocked) throw new Error(`Funding migration blocked by ${blocked}`);
    if (
      !(await input.verifyOldPaid(
        active.agentWallet,
        stagedMigration.priorReceiptHash,
      ))
    )
      throw new Error("Exact prior old-wallet Paid proof is missing");
    if (!(await input.verifyStaged(staged)))
      throw new Error(
        "Staged zero-wallet deployment failed chain verification",
      );
    mkdirSync(input.archiveDir, { recursive: true, mode: 0o700 });
    if ((statSync(input.archiveDir).mode & 0o077) !== 0)
      throw new Error("Migration archive is not owner-only");
    const backupDir = join(
      input.archiveDir,
      `funding-cutover-${Date.now()}-${randomUUID()}`,
    );
    mkdirSync(backupDir, { mode: 0o700 });
    for (const [source, target] of [
      [input.activePath, "addresses.json"],
      [input.statePath, "gateway-state.json"],
      [input.identityPath, "gateway-state.json.identity"],
    ] as const) {
      writeAtomic(join(backupDir, target), readFileSync(source, "utf8"));
    }
    marker = {
      version: 1,
      phase: "prepared",
      backupDir,
      oldHash,
      stagedHash,
      stateHash: fileHash(input.statePath),
      identityHash: fileHash(input.identityPath),
    };
    writeAtomic(input.markerPath, `${JSON.stringify(marker)}\n`);
  }
  const backupActivePath = join(marker.backupDir, "addresses.json");
  const backupStatePath = join(marker.backupDir, "gateway-state.json");
  const backupIdentityPath = join(
    marker.backupDir,
    "gateway-state.json.identity",
  );
  for (const path of [backupActivePath, backupStatePath, backupIdentityPath])
    ownerFile(path);
  if (
    fileHash(backupActivePath) !== marker.oldHash ||
    fileHash(backupStatePath) !== marker.stateHash ||
    fileHash(backupIdentityPath) !== marker.identityHash
  )
    throw new Error("Original migration backup changed");
  const old = readDeployment(backupActivePath);
  const newDeployment: Deployment = {
    ...staged,
    migration: { ...stagedMigration, state: "active" },
  };
  const targetContext = JSON.stringify(newDeployment);
  const original = readEnvelope(backupStatePath);
  if (original.payload.context !== JSON.stringify(old))
    throw new Error("Original Gateway state backup changed");
  const targetPayload = structuredClone(original.payload);
  targetPayload.context = targetContext;
  const expiredPreviews = new Set(
    (
      targetPayload.fundingRecords as
        | Array<{ fundingId: string; status: string }>
        | undefined
    )
      ?.filter((item) => item.status === "prepared")
      .map((item) => item.fundingId) ?? [],
  );
  targetPayload.fundingRecords = (
    (targetPayload.fundingRecords ?? []) as Array<{ fundingId: string }>
  ).filter((item) => !expiredPreviews.has(item.fundingId));
  targetPayload.fundingChallenges = (
    (targetPayload.fundingChallenges ?? []) as Array<{ fundingId: string }>
  ).filter((item) => !expiredPreviews.has(item.fundingId));
  targetPayload.payments = (
    targetPayload.payments as Array<Record<string, unknown>>
  ).map((payment) => ({
    ...payment,
    deployment: payment.deployment ?? JSON.stringify(old),
  }));
  const targetState = `${JSON.stringify({ version: 1, payload: targetPayload, sha256: digest(targetPayload) })}\n`;
  const currentAddressesHash = fileHash(input.activePath);
  const newAddresses = `${JSON.stringify(newDeployment, null, 2)}\n`;
  const newAddressesHash = createHash("sha256")
    .update(newAddresses)
    .digest("hex");
  if (
    currentAddressesHash !== marker.oldHash &&
    currentAddressesHash !== newAddressesHash
  )
    throw new Error("Active deployment changed during cutover");
  const currentStateHash = fileHash(input.statePath);
  const targetStateHash = createHash("sha256")
    .update(targetState)
    .digest("hex");
  if (
    currentStateHash !== marker.stateHash &&
    currentStateHash !== targetStateHash
  )
    throw new Error("Gateway state changed during cutover");
  if (fileHash(input.identityPath) !== marker.identityHash)
    throw new Error("Gateway signing identity changed during cutover");
  if (marker.phase === "prepared") {
    await input.freezeOldWallet(old.agentWallet);
    marker.phase = "frozen";
    writeAtomic(input.markerPath, `${JSON.stringify(marker)}\n`);
  }
  if (marker.phase === "frozen") {
    writeAtomic(input.statePath, targetState);
    marker.phase = "state_written";
    writeAtomic(input.markerPath, `${JSON.stringify(marker)}\n`);
  }
  if (marker.phase === "state_written") {
    writeAtomic(input.activePath, newAddresses);
    marker.phase = "addresses_written";
    writeAtomic(input.markerPath, `${JSON.stringify(marker)}\n`);
  }
  if (
    marker.phase !== "addresses_written" ||
    readEnvelope(input.statePath).payload.context !== targetContext ||
    JSON.stringify(readDeployment(input.activePath)) !== targetContext
  )
    throw new Error("Funding cutover verification failed; marker retained");
  unlinkSync(input.markerPath);
  return { backupDir: marker.backupDir, activeDeployment: newDeployment };
}
