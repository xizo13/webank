import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableState } from "../src/durable-state.js";
import {
  attachHumanPaymentEvidence,
  type HumanTransferCandidate,
  inspectHumanPaymentRecovery,
} from "../src/human-recovery.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const hash = `0x${"a".repeat(64)}` as const;
const payout = `0x${"b".repeat(40)}` as const;
const candidate: HumanTransferCandidate = { hash, blockNumber: 24n };
const baseRecord = {
  confirmationId: "hpm_test",
  userId: "usr_test",
  merchantId: "mch_shopA",
  orderId: "ord_1",
  payout,
  amount: 1200,
  paymentRequestHash: `sha256:${"c".repeat(64)}`,
  startingBlock: "20",
  deployment: "deployment",
  status: "reconciliation_required",
};

function fixture(
  records: Array<
    typeof baseRecord & { txHash?: `0x${string}`; blockNumber?: string }
  > = [baseRecord],
) {
  const dir = mkdtempSync(join(tmpdir(), "webank-human-recovery-"));
  dirs.push(dir);
  const statePath = join(dir, "gateway-state.json");
  const store = new DurableState(statePath);
  store.save({ context: "context", humanPaymentRecords: records });
  store.close();
  let candidates = [candidate];
  const input = {
    statePath,
    context: "context",
    deployment: "deployment",
    confirmationId: "hpm_test",
    findCandidates: async () => candidates,
    verify: async () => candidate,
  };
  return {
    input,
    setCandidates(next: HumanTransferCandidate[]) {
      candidates = next;
    },
    saved() {
      const reader = new DurableState<{
        humanPaymentRecords: Array<
          typeof baseRecord & { txHash?: `0x${string}`; blockNumber?: string }
        >;
      }>(statePath);
      try {
        return reader.load()?.humanPaymentRecords;
      } finally {
        reader.close();
      }
    },
  };
}

describe("offline lost-hash human payment recovery", () => {
  it("inspects a persisted intent without attaching or sending a payment", async () => {
    const test = fixture();
    const result = await inspectHumanPaymentRecovery(test.input);
    expect(result.candidates).toEqual([candidate]);
    expect(result.startingBlock).toBe("20");
    expect(test.saved()?.[0]?.txHash).toBeUndefined();
  });

  it("keeps zero or multiple chain candidates operator-held", async () => {
    const test = fixture();
    test.setCandidates([]);
    const attach = {
      ...test.input,
      hash,
      attestSoleBankWriter: true as const,
      attestOrderAttribution: true as const,
    };
    await expect(attachHumanPaymentEvidence(attach)).rejects.toThrow(
      "Zero or multiple",
    );
    test.setCandidates([
      candidate,
      { ...candidate, hash: `0x${"d".repeat(64)}` },
    ]);
    await expect(attachHumanPaymentEvidence(attach)).rejects.toThrow(
      "Zero or multiple",
    );
    expect(test.saved()?.[0]?.txHash).toBeUndefined();
  });

  it("requires exact independent evidence and explicit operator attestations", async () => {
    const test = fixture();
    const attach = {
      ...test.input,
      hash,
      attestSoleBankWriter: true as const,
      attestOrderAttribution: true as const,
    };
    await expect(
      attachHumanPaymentEvidence({
        ...attach,
        attestOrderAttribution: false as never,
      }),
    ).rejects.toThrow("attestations");
    await expect(
      attachHumanPaymentEvidence({
        ...attach,
        verify: async () => ({ ...candidate, blockNumber: 25n }),
      }),
    ).rejects.toThrow("evidence");
    const result = await attachHumanPaymentEvidence(attach);
    expect(result.status).toBe("reconciliation_required");
    expect(test.saved()?.[0]).toMatchObject({
      status: "reconciliation_required",
      txHash: hash,
      blockNumber: "24",
    });
    await expect(attachHumanPaymentEvidence(attach)).rejects.toThrow(
      "not awaiting",
    );
  });

  it("refuses attribution when another unresolved same-payout intent overlaps the transfer", async () => {
    const test = fixture([
      baseRecord,
      {
        ...baseRecord,
        confirmationId: "hpm_other",
        orderId: "ord_2",
        startingBlock: "22",
      },
    ]);
    await expect(
      attachHumanPaymentEvidence({
        ...test.input,
        hash,
        attestSoleBankWriter: true,
        attestOrderAttribution: true,
      }),
    ).rejects.toThrow("competing");
    expect(test.saved()?.[0]?.txHash).toBeUndefined();
  });

  it("refuses the wrong deployment and active Gateway writer", async () => {
    const test = fixture();
    await expect(
      inspectHumanPaymentRecovery({ ...test.input, deployment: "another" }),
    ).rejects.toThrow("active intent");
    const gatewayWriter = new DurableState(test.input.statePath);
    try {
      await expect(inspectHumanPaymentRecovery(test.input)).rejects.toThrow(
        "active writer",
      );
    } finally {
      gatewayWriter.close();
    }
  });
});
