import { DurableState } from "./durable-state.js";

export type HumanTransferCandidate = {
  hash: `0x${string}`;
  blockNumber: bigint;
};

type RecoveryRecord = {
  confirmationId: string;
  userId: string;
  merchantId: string;
  orderId: string;
  payout: `0x${string}`;
  amount: number;
  paymentRequestHash: string;
  startingBlock: string;
  deployment: string;
  status: string;
  txHash?: `0x${string}`;
  blockNumber?: string;
};

type RecoveryState = {
  context: string;
  humanPaymentRecords?: RecoveryRecord[];
};

export type HumanRecoveryInput = {
  statePath: string;
  context: string;
  deployment: string;
  confirmationId: string;
  findCandidates(record: RecoveryRecord): Promise<HumanTransferCandidate[]>;
  verify(
    hash: `0x${string}`,
    record: RecoveryRecord,
  ): Promise<HumanTransferCandidate>;
};

/** Offline operator path. Gateway must be stopped so DurableState can own the writer lock. */
export async function inspectHumanPaymentRecovery(input: HumanRecoveryInput) {
  const store = new DurableState<RecoveryState>(input.statePath);
  try {
    const state = store.load();
    if (!state || state.context !== input.context)
      throw new Error("Gateway state does not match the active deployment");
    const record = state.humanPaymentRecords?.find(
      (item) => item.confirmationId === input.confirmationId,
    );
    if (
      record?.status !== "reconciliation_required" ||
      record.deployment !== input.deployment ||
      !/^[0-9]+$/.test(record.startingBlock) ||
      !/^sha256:[0-9a-f]{64}$/.test(record.paymentRequestHash) ||
      !/^0x[0-9a-fA-F]{40}$/.test(record.payout) ||
      !Number.isSafeInteger(record.amount) ||
      record.amount <= 0
    )
      throw new Error("Human payment is not an unresolved active intent");
    const candidates = await input.findCandidates(record);
    return {
      confirmationId: record.confirmationId,
      merchantId: record.merchantId,
      orderId: record.orderId,
      amount: record.amount,
      payout: record.payout,
      paymentRequestHash: record.paymentRequestHash,
      startingBlock: record.startingBlock,
      alreadyAttached: record.txHash ?? null,
      candidates,
    };
  } finally {
    store.close();
  }
}

/** Attach only one operator-attested, uniquely matching chain transfer; never broadcast. */
export async function attachHumanPaymentEvidence(
  input: HumanRecoveryInput & {
    hash: `0x${string}`;
    attestSoleBankWriter: true;
    attestOrderAttribution: true;
  },
) {
  if (
    input.attestSoleBankWriter !== true ||
    input.attestOrderAttribution !== true
  )
    throw new Error(
      "Bank-writer and order-attribution attestations are required",
    );
  const store = new DurableState<RecoveryState>(input.statePath);
  try {
    const state = store.load();
    if (!state || state.context !== input.context)
      throw new Error("Gateway state does not match the active deployment");
    const records = state.humanPaymentRecords ?? [];
    const record = records.find(
      (item) => item.confirmationId === input.confirmationId,
    );
    if (
      record?.status !== "reconciliation_required" ||
      record.deployment !== input.deployment ||
      record.txHash ||
      !/^[0-9]+$/.test(record.startingBlock) ||
      !/^sha256:[0-9a-f]{64}$/.test(record.paymentRequestHash) ||
      !/^0x[0-9a-fA-F]{40}$/.test(record.payout) ||
      !Number.isSafeInteger(record.amount) ||
      record.amount <= 0
    )
      throw new Error("Human payment is not awaiting lost-hash reconciliation");
    const candidates = await input.findCandidates(record);
    if (
      candidates.length !== 1 ||
      candidates[0]?.hash.toLowerCase() !== input.hash.toLowerCase()
    )
      throw new Error(
        "Zero or multiple matching transfers remain operator-held",
      );
    const evidence = await input.verify(input.hash, record);
    if (
      evidence.hash.toLowerCase() !== input.hash.toLowerCase() ||
      evidence.blockNumber < BigInt(record.startingBlock) ||
      evidence.blockNumber !== candidates[0].blockNumber
    )
      throw new Error("Candidate transaction evidence does not match intent");
    const competing = records.some((item) => {
      if (item.confirmationId === record.confirmationId) return false;
      if (item.txHash?.toLowerCase() === input.hash.toLowerCase()) return true;
      if (item.status === "failed" || item.status === "prepared") return false;
      if (
        item.payout.toLowerCase() !== record.payout.toLowerCase() ||
        item.amount !== record.amount
      )
        return false;
      if (!/^[0-9]+$/.test(item.startingBlock)) return true;
      if (BigInt(item.startingBlock) > evidence.blockNumber) return false;
      return (
        !item.blockNumber ||
        !/^[0-9]+$/.test(item.blockNumber) ||
        BigInt(item.blockNumber) >= BigInt(record.startingBlock)
      );
    });
    if (competing)
      throw new Error(
        "A competing human payment intent requires manual review",
      );
    record.txHash = input.hash;
    record.blockNumber = evidence.blockNumber.toString();
    store.save(state);
    return {
      confirmationId: record.confirmationId,
      txHash: input.hash,
      blockNumber: evidence.blockNumber,
      status: "reconciliation_required" as const,
    };
  } finally {
    store.close();
  }
}
