import type { FiscoChain } from "@webank/chain";
import type { Address, Hex } from "viem";

type Money = { amount: number; currency: string };

export type BankPolicyIntent = {
  changeId: string;
  userId: string;
  status: string;
  auditHash?: string;
  baseCaps: { perPayment: number; daily: number; monthly: number };
  proposed: {
    per_payment_max: Money;
    daily_max: Money;
    monthly_max: Money;
  };
  deployment: string;
};

type AuditEvidence = {
  record_hash: string;
  subject_id: string;
  actor?: string;
  kind: string;
};

/** Validate the durable intent the bank child will sign, including its exact audit subject. */
export function assertAuditedPolicyIntent(
  intent: BankPolicyIntent | undefined,
  audits: AuditEvidence[] | undefined,
  expectedDeployment: string,
  amount: bigint,
): asserts intent is BankPolicyIntent & { auditHash: string } {
  const target = intent?.proposed;
  if (
    amount !== 1n ||
    !intent ||
    !/^pch_[A-Za-z0-9_-]+$/.test(intent.changeId) ||
    intent.status !== "applying" ||
    intent.deployment !== expectedDeployment ||
    !/^sha256:[0-9a-fA-F]{64}$/.test(intent.auditHash ?? "") ||
    !target ||
    [target.per_payment_max, target.daily_max, target.monthly_max].some(
      (money) =>
        money.currency !== "CNY" ||
        !Number.isSafeInteger(money.amount) ||
        money.amount <= 0,
    ) ||
    target.per_payment_max.amount > target.daily_max.amount ||
    target.daily_max.amount > target.monthly_max.amount ||
    !audits?.some(
      (audit) =>
        audit.record_hash === intent.auditHash &&
        audit.subject_id === intent.changeId &&
        audit.actor === intent.userId &&
        audit.kind === "policy_change",
    )
  )
    throw new Error("No exact audited policy intent exists");
}
/** Execute only an audited base-to-target cap transition and verify chain readback. */
export async function applyAuditedPolicyCaps(
  chain: Pick<FiscoChain, "getPolicyCapsSnapshot" | "setCaps">,
  wallet: Address,
  intent: BankPolicyIntent,
): Promise<Hex> {
  const current = await chain.getPolicyCapsSnapshot(wallet);
  const base = intent.baseCaps;
  const target = intent.proposed;
  const baseMatches =
    current.perPaymentCap === BigInt(base.perPayment) &&
    current.dailyCap === BigInt(base.daily) &&
    current.monthlyCap === BigInt(base.monthly);
  const targetMatches =
    current.perPaymentCap === BigInt(target.per_payment_max.amount) &&
    current.dailyCap === BigInt(target.daily_max.amount) &&
    current.monthlyCap === BigInt(target.monthly_max.amount);
  if (!baseMatches && !targetMatches)
    throw new Error("Contract caps changed outside audited policy intent");
  if (targetMatches)
    throw new Error(
      "Contract caps already match; Gateway must reconcile readback",
    );
  const tx = await chain.setCaps(
    wallet,
    BigInt(target.per_payment_max.amount),
    BigInt(target.daily_max.amount),
    BigInt(target.monthly_max.amount),
  );
  const confirmed = await chain.getPolicyCapsSnapshot(wallet);
  if (
    confirmed.perPaymentCap !== BigInt(target.per_payment_max.amount) ||
    confirmed.dailyCap !== BigInt(target.daily_max.amount) ||
    confirmed.monthlyCap !== BigInt(target.monthly_max.amount)
  )
    throw new Error("Contract cap confirmation mismatch");
  return tx;
}
