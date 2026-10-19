import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableState } from "../src/durable-state.js";
import { migrateFundingDeployment } from "../src/funding-migration.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const wallet = `0x${"2".repeat(40)}`;
const token = `0x${"3".repeat(40)}`;
const receipt = `0x${"4".repeat(64)}`;
const old = {
  chainId: 20200,
  rpcUrl: "http://127.0.0.1:8545",
  bank: `0x${"1".repeat(40)}`,
  gateway: `0x${"5".repeat(40)}`,
  ecnySim: token,
  agentWallet: wallet,
  merchantRegistry: `0x${"6".repeat(40)}`,
  licenceRegistry: `0x${"7".repeat(40)}`,
  auditAnchor: `0x${"8".repeat(40)}`,
  deploymentFingerprint: "old",
};
const staged = {
  ...old,
  ecnySim: `0x${"9".repeat(40)}`,
  agentWallet: `0x${"a".repeat(40)}`,
  deploymentFingerprint: "new",
  migration: {
    state: "staged",
    priorAddresses: { ecnySim: token, agentWallet: wallet },
    priorDeploymentFingerprint: "old",
    priorReceiptHash: receipt,
  },
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "webank-migrate-"));
  const activePath = join(dir, "addresses.json");
  const stagedPath = join(dir, "stage.json");
  const statePath = join(dir, "gateway-state.json");
  const identityPath = join(dir, "gateway-state.json.identity");
  const markerPath = join(dir, "funding-cutover.json");
  const archiveDir = join(dir, "archive");
  const payload = {
    context: JSON.stringify(old),
    mandates: [],
    approvals: [],
    pairings: [],
    payments: [{ id: "historic", status: "paid" }],
    fundingRecords: [],
    sweepRecords: [],
  };
  const write = (path: string, value: string) =>
    writeFileSync(path, value, { mode: 0o600 });
  write(activePath, `${JSON.stringify(old, null, 2)}\n`);
  write(stagedPath, `${JSON.stringify(staged, null, 2)}\n`);
  write(
    statePath,
    `${JSON.stringify({ version: 1, payload, sha256: hash(JSON.stringify(payload)) })}\n`,
  );
  write(identityPath, "owner-key-placeholder\n");
  let frozen = false;
  let proofCalls = 0;
  const input = {
    activePath,
    stagedPath,
    statePath,
    identityPath,
    markerPath,
    archiveDir,
    verifyOldPaid: async (address: string, tx: string) => {
      proofCalls++;
      return address === wallet && tx === receipt;
    },
    verifyStaged: async () => true,
    freezeOldWallet: async (address: string) => {
      expect(address).toBe(wallet);
      frozen = true;
    },
  };
  return {
    dir,
    input,
    payload,
    frozen: () => frozen,
    proofCalls: () => proofCalls,
  };
}

describe("explicit funding cutover", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it("preserves old payment identity and resumes after addresses were written", async () => {
    const f = fixture();
    dirs.push(f.dir);
    const result = await migrateFundingDeployment(f.input);
    expect(f.frozen()).toBe(true);
    expect(f.proofCalls()).toBe(1);
    const migrated = JSON.parse(readFileSync(f.input.statePath, "utf8"));
    expect(migrated.payload.payments[0].deployment).toBe(JSON.stringify(old));
    expect(migrated.payload.context).toBe(
      JSON.stringify(result.activeDeployment),
    );
    const marker = {
      version: 1,
      phase: "addresses_written",
      backupDir: result.backupDir,
      oldHash: hash(
        readFileSync(join(result.backupDir, "addresses.json"), "utf8"),
      ),
      stagedHash: hash(readFileSync(f.input.stagedPath, "utf8")),
      stateHash: hash(
        readFileSync(join(result.backupDir, "gateway-state.json"), "utf8"),
      ),
      identityHash: hash(
        readFileSync(
          join(result.backupDir, "gateway-state.json.identity"),
          "utf8",
        ),
      ),
    };
    writeFileSync(f.input.markerPath, JSON.stringify(marker), { mode: 0o600 });
    await migrateFundingDeployment(f.input);
    expect(f.proofCalls()).toBe(1);
  });

  it("rejects active work and a missing exact old Paid proof", async () => {
    const f = fixture();
    dirs.push(f.dir);
    const state = JSON.parse(readFileSync(f.input.statePath, "utf8"));
    state.payload.mandates.push({ status: "active" });
    state.sha256 = hash(JSON.stringify(state.payload));
    writeFileSync(f.input.statePath, JSON.stringify(state), { mode: 0o600 });
    await expect(migrateFundingDeployment(f.input)).rejects.toThrow(
      "active mandate",
    );
    state.payload.mandates = [];
    state.sha256 = hash(JSON.stringify(state.payload));
    writeFileSync(f.input.statePath, JSON.stringify(state), { mode: 0o600 });
    await expect(
      migrateFundingDeployment({
        ...f.input,
        verifyOldPaid: async () => false,
      }),
    ).rejects.toThrow("Exact prior old-wallet Paid proof");
  });

  it("allows cutover after an abandoned funding preview that never submitted a transfer", async () => {
    const f = fixture();
    dirs.push(f.dir);
    const state = JSON.parse(readFileSync(f.input.statePath, "utf8"));
    state.payload.fundingRecords.push({
      fundingId: "fnd_preview",
      status: "prepared",
    });
    state.payload.fundingChallenges = [
      {
        fundingId: "fnd_preview",
        expiresAt: Date.now() - 1,
        consumed: false,
      },
    ];
    state.payload.fundingKeys = [];
    state.sha256 = hash(JSON.stringify(state.payload));
    writeFileSync(f.input.statePath, JSON.stringify(state), { mode: 0o600 });
    await expect(migrateFundingDeployment(f.input)).resolves.toMatchObject({
      activeDeployment: { migration: { state: "active" } },
    });
    const migrated = JSON.parse(readFileSync(f.input.statePath, "utf8"));
    expect(migrated.payload.fundingRecords).toEqual([]);
    expect(migrated.payload.fundingChallenges).toEqual([]);
  });

  it("keeps a live or submitted funding intent behind the migration fence", async () => {
    const f = fixture();
    dirs.push(f.dir);
    const state = JSON.parse(readFileSync(f.input.statePath, "utf8"));
    state.payload.fundingRecords.push({
      fundingId: "fnd_live",
      status: "prepared",
    });
    state.payload.fundingChallenges = [
      {
        fundingId: "fnd_live",
        expiresAt: Date.now() + 60_000,
        consumed: false,
      },
    ];
    state.payload.fundingKeys = [];
    state.sha256 = hash(JSON.stringify(state.payload));
    writeFileSync(f.input.statePath, JSON.stringify(state), { mode: 0o600 });
    await expect(migrateFundingDeployment(f.input)).rejects.toThrow(
      "pending or uncertain funding",
    );
    state.payload.fundingRecords[0].status = "settling";
    state.payload.fundingChallenges[0].expiresAt = Date.now() - 1;
    state.sha256 = hash(JSON.stringify(state.payload));
    writeFileSync(f.input.statePath, JSON.stringify(state), { mode: 0o600 });
    await expect(migrateFundingDeployment(f.input)).rejects.toThrow(
      "pending or uncertain funding",
    );
  });

  it("refuses cutover while an agent replacement spending fence is unresolved", async () => {
    const f = fixture();
    dirs.push(f.dir);
    const state = JSON.parse(readFileSync(f.input.statePath, "utf8"));
    state.payload.replacingAgents = ["agt_crash_recovery"];
    state.sha256 = hash(JSON.stringify(state.payload));
    writeFileSync(f.input.statePath, JSON.stringify(state), { mode: 0o600 });
    await expect(migrateFundingDeployment(f.input)).rejects.toThrow(
      "replacement",
    );
  });

  it("excludes a concurrent Gateway startup throughout chain verification", async () => {
    const f = fixture();
    dirs.push(f.dir);
    let entered!: () => void;
    let release!: () => void;
    const verifying = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const migration = migrateFundingDeployment({
      ...f.input,
      verifyOldPaid: async () => {
        entered();
        await blocked;
        return true;
      },
    });
    await verifying;
    let competing: DurableState<unknown> | undefined;
    try {
      competing = new DurableState(f.input.statePath);
    } catch {
      // The migration owns the same writer lock.
    }
    competing?.close();
    release();
    await migration;
    expect(competing).toBeUndefined();
  });

  it("refuses an existing stale writer lock without stealing it", async () => {
    const f = fixture();
    dirs.push(f.dir);
    const lockPath = `${f.input.statePath}.lock`;
    writeFileSync(lockPath, "99999999", { mode: 0o600 });
    await expect(migrateFundingDeployment(f.input)).rejects.toThrow(
      "Gateway writer lock exists",
    );
    expect(readFileSync(lockPath, "utf8")).toBe("99999999");
  });
});
