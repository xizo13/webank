import {
  type Commitment,
  CommitmentSchema,
  type Money,
  type Policy,
  PolicySchema,
} from "@webank/contracts";

export type Invariant =
  | "reserved_exceeds_approved_due"
  | "buffer_exceeds_target"
  | "daily_topup_ceiling"
  | "monthly_topup_ceiling"
  | "protected_main_balance"
  | "reserved_payee_mismatch"
  | "payment_without_approved_decision"
  | "invalid_snapshot"
  | "unauthorized_funding";

export interface ApprovedCommitment {
  commitment: Commitment;
  proposalId: string;
}

export interface ReservedBalance {
  commitmentId: string;
  payeeMerchantId: string;
  amount: Money;
}

export interface FundingRecord {
  userId: string;
  destinationUserId: string;
  pot: "reserved" | "buffer";
  debit: Money;
  credited: Money;
  at: string;
  proposalId: string;
  commitmentId?: string;
}

export interface PaymentEvidence {
  commitmentId?: string;
  payeeMerchantId: string;
  amount: Money;
  fromPot: "reserved" | "buffer";
  decisionId: string;
  onChain: boolean;
}

export interface TreasurySnapshot {
  userId: string;
  policy: Policy;
  mainBalance: Money;
  buffer: Money;
  reserved: ReservedBalance[];
  approvedCommitments: ApprovedCommitment[];
  approvedBufferTargets: { proposalId: string; target: Money }[];
  topups: FundingRecord[];
  payments: PaymentEvidence[];
  approvedDecisionIds: string[];
  treasurerFrozen: boolean;
}

export interface Violation {
  invariant: Invariant;
  detail: string;
}

const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

function dayKey(date: Date): string {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validMoney(money: unknown): money is Money {
  return (
    isRecord(money) &&
    Number.isSafeInteger(money.amount) &&
    typeof money.amount === "number" &&
    money.amount >= 0 &&
    typeof money.currency === "string" &&
    /^[A-Z]{3}$/.test(money.currency)
  );
}

function sameCurrency(left: Money, right: Money): boolean {
  return left.currency === right.currency;
}

function validTimestamp(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validSnapshotEnvelope(value: unknown): value is TreasurySnapshot {
  if (!isRecord(value) || typeof value.userId !== "string") return false;
  if (!PolicySchema.safeParse(value.policy).success) return false;
  const policy = value.policy as Policy;
  if (
    policy.user_id !== value.userId ||
    !validMoney(value.mainBalance) ||
    !validMoney(value.buffer) ||
    (value.treasurerFrozen !== true && value.treasurerFrozen !== false) ||
    !Array.isArray(value.reserved) ||
    !Array.isArray(value.approvedCommitments) ||
    !Array.isArray(value.approvedBufferTargets) ||
    !Array.isArray(value.topups) ||
    !Array.isArray(value.payments) ||
    !Array.isArray(value.approvedDecisionIds)
  )
    return false;
  const baseCurrency = value.mainBalance.currency;
  const policyMoney = [
    policy.treasurer.buffer_target,
    policy.treasurer.daily_topup_ceiling,
    policy.treasurer.monthly_topup_ceiling,
    policy.treasurer.protected_main_balance,
  ];
  if (
    value.buffer.currency !== baseCurrency ||
    policyMoney.some((money) => money.currency !== baseCurrency) ||
    !value.approvedDecisionIds.every((id) => typeof id === "string")
  )
    return false;
  if (
    value.reserved.some(
      (item) =>
        !isRecord(item) ||
        typeof item.commitmentId !== "string" ||
        typeof item.payeeMerchantId !== "string" ||
        !validMoney(item.amount),
    )
  )
    return false;
  if (
    value.approvedCommitments.some(
      (item) =>
        !isRecord(item) ||
        typeof item.proposalId !== "string" ||
        !CommitmentSchema.safeParse(item.commitment).success,
    )
  )
    return false;
  if (
    value.approvedBufferTargets.some(
      (item) =>
        !isRecord(item) ||
        typeof item.proposalId !== "string" ||
        !validMoney(item.target),
    )
  )
    return false;
  if (
    value.topups.some(
      (item) =>
        !isRecord(item) ||
        typeof item.userId !== "string" ||
        typeof item.destinationUserId !== "string" ||
        (item.pot !== "reserved" && item.pot !== "buffer") ||
        !validMoney(item.debit) ||
        !validMoney(item.credited) ||
        !validTimestamp(item.at as string) ||
        typeof item.proposalId !== "string" ||
        (item.commitmentId !== undefined &&
          typeof item.commitmentId !== "string"),
    )
  )
    return false;
  if (
    value.payments.some(
      (item) =>
        !isRecord(item) ||
        typeof item.payeeMerchantId !== "string" ||
        !validMoney(item.amount) ||
        (item.fromPot !== "reserved" && item.fromPot !== "buffer") ||
        typeof item.decisionId !== "string" ||
        typeof item.onChain !== "boolean" ||
        (item.commitmentId !== undefined &&
          typeof item.commitmentId !== "string"),
    )
  )
    return false;
  return true;
}

/** Pure watchdog.  It fails closed if a balance, currency, or timestamp is malformed. */
export function checkInvariants(snapshot: unknown, now: Date): Violation[] {
  const violations: Violation[] = [];
  const add = (invariant: Invariant, detail: string) =>
    violations.push({ invariant, detail });
  if (
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    !validSnapshotEnvelope(snapshot)
  ) {
    add(
      "invalid_snapshot",
      "Malformed balance, policy, owner, record, or time",
    );
    return violations;
  }
  const policy = snapshot.policy.treasurer;
  const baseCurrency = snapshot.mainBalance.currency;
  const baseAmounts = [
    snapshot.mainBalance,
    snapshot.buffer,
    policy.buffer_target,
    policy.daily_topup_ceiling,
    policy.monthly_topup_ceiling,
    policy.protected_main_balance,
  ];
  if (
    baseAmounts.some(
      (money) => !validMoney(money) || money.currency !== baseCurrency,
    )
  )
    return [
      { invariant: "invalid_snapshot", detail: "Malformed base currency" },
    ];

  if (snapshot.buffer.amount > policy.buffer_target.amount)
    add("buffer_exceeds_target", "Buffer exceeds the approved target");
  if (snapshot.mainBalance.amount < policy.protected_main_balance.amount)
    add(
      "protected_main_balance",
      "Main balance is below the protected minimum",
    );

  const approved = new Map(
    snapshot.approvedCommitments.map((item) => [
      item.commitment.commitment_id,
      item,
    ]),
  );
  const reservedTotals = new Map<string, number>();
  for (const pot of snapshot.reserved) {
    const item = approved.get(pot.commitmentId);
    if (!validMoney(pot.amount) || !item) {
      add(
        "reserved_exceeds_approved_due",
        `Unapproved reserved balance for ${pot.commitmentId}`,
      );
      continue;
    }
    const commitment = item.commitment;
    const total =
      (reservedTotals.get(pot.commitmentId) ?? 0) + pot.amount.amount;
    reservedTotals.set(pot.commitmentId, total);
    const dueStart = Date.parse(`${commitment.next_due}T00:00:00+08:00`);
    const dueEnd = dueStart + DAY_MS;
    if (
      commitment.status !== "active" ||
      !Number.isFinite(dueStart) ||
      dueStart > now.getTime() + 48 * 3_600_000 ||
      dueEnd <= now.getTime() ||
      !sameCurrency(pot.amount, commitment.amount) ||
      !Number.isSafeInteger(total) ||
      total > commitment.amount.amount
    )
      add(
        "reserved_exceeds_approved_due",
        `Reserved balance is outside approved 48h due amount for ${pot.commitmentId}`,
      );
    if (pot.payeeMerchantId !== commitment.payee_merchant_id)
      add(
        "reserved_payee_mismatch",
        `Reserved payee does not match ${pot.commitmentId}`,
      );
  }

  let today = 0;
  let month = 0;
  const todayKey = dayKey(now);
  for (const record of snapshot.topups) {
    if (
      record.userId !== snapshot.userId ||
      record.destinationUserId !== snapshot.userId ||
      !validMoney(record.debit) ||
      !validMoney(record.credited) ||
      record.debit.currency !== baseCurrency ||
      !validTimestamp(record.at)
    ) {
      add("invalid_snapshot", "Malformed or cross-user top-up record");
      continue;
    }
    const key = dayKey(new Date(record.at));
    if (key === todayKey) today += record.debit.amount;
    if (key.slice(0, 7) === todayKey.slice(0, 7)) month += record.debit.amount;
  }
  if (!Number.isSafeInteger(today) || today > policy.daily_topup_ceiling.amount)
    add("daily_topup_ceiling", "Today's top-ups exceed the daily ceiling");
  if (
    !Number.isSafeInteger(month) ||
    month > policy.monthly_topup_ceiling.amount
  )
    add(
      "monthly_topup_ceiling",
      "This month's top-ups exceed the monthly ceiling",
    );

  const decisionIds = new Set(snapshot.approvedDecisionIds);
  for (const payment of snapshot.payments) {
    if (payment.onChain && !decisionIds.has(payment.decisionId))
      add(
        "payment_without_approved_decision",
        `Payment lacks APPROVED decision ${payment.decisionId}`,
      );
    if (payment.fromPot === "reserved") {
      const item = payment.commitmentId
        ? approved.get(payment.commitmentId)
        : undefined;
      if (
        !item ||
        !validMoney(payment.amount) ||
        item.commitment.payee_merchant_id !== payment.payeeMerchantId ||
        !sameCurrency(item.commitment.amount, payment.amount) ||
        payment.amount.amount > item.commitment.amount.amount
      )
        add(
          "reserved_payee_mismatch",
          `Reserved payment is not bound to its commitment`,
        );
    }
  }
  return violations;
}

export interface FundingAttempt {
  record: FundingRecord;
  reservedPayeeMerchantId?: string;
}

/** Check the proposed post-transfer state before core banking performs a transfer. */
export function checkFundingAttempt(
  snapshot: TreasurySnapshot,
  attempt: FundingAttempt,
  now: Date,
): Violation[] {
  const snapshotViolations = checkInvariants(snapshot, now);
  if (snapshotViolations.length > 0) return snapshotViolations;
  if (!isRecord(attempt) || !isRecord(attempt.record))
    return [
      {
        invariant: "unauthorized_funding",
        detail: "Malformed funding attempt",
      },
    ];
  const record = attempt.record;
  const violations: Violation[] = [];
  if (
    snapshot.treasurerFrozen ||
    !snapshot.policy.treasurer.enabled ||
    (record.pot !== "reserved" && record.pot !== "buffer") ||
    record.userId !== snapshot.userId ||
    record.destinationUserId !== snapshot.userId ||
    !validMoney(record.debit) ||
    !validMoney(record.credited) ||
    record.debit.amount <= 0 ||
    record.credited.amount <= 0 ||
    record.debit.currency !== snapshot.mainBalance.currency ||
    !validTimestamp(record.at) ||
    Math.abs(Date.parse(record.at) - now.getTime()) > 1_000
  )
    violations.push({
      invariant: "unauthorized_funding",
      detail: "Funding is disabled, cross-user, malformed, or stale",
    });
  if (violations.length > 0) return violations;
  const approved = record.commitmentId
    ? snapshot.approvedCommitments.find(
        (item) =>
          item.commitment.commitment_id === record.commitmentId &&
          item.proposalId === record.proposalId,
      )
    : undefined;
  if (
    record.pot === "reserved" &&
    (!approved ||
      !attempt.reservedPayeeMerchantId ||
      approved.commitment.payee_merchant_id !==
        attempt.reservedPayeeMerchantId ||
      approved.commitment.amount.currency !== record.credited.currency)
  )
    violations.push({
      invariant: "unauthorized_funding",
      detail: "No exact user-approved commitment and payee",
    });
  if (record.pot === "buffer" && record.commitmentId)
    violations.push({
      invariant: "unauthorized_funding",
      detail: "Buffer funding cannot claim a commitment",
    });
  if (
    record.pot === "buffer" &&
    (record.credited.currency !== snapshot.buffer.currency ||
      !snapshot.approvedBufferTargets.some(
        (item) =>
          item.proposalId === record.proposalId &&
          item.target.currency === record.credited.currency &&
          item.target.amount === snapshot.policy.treasurer.buffer_target.amount,
      ))
  )
    violations.push({
      invariant: "unauthorized_funding",
      detail: "No exact user-approved buffer target",
    });
  if (violations.length > 0) return violations;

  const preview: TreasurySnapshot = {
    ...snapshot,
    mainBalance: {
      ...snapshot.mainBalance,
      amount: snapshot.mainBalance.amount - record.debit.amount,
    },
    buffer:
      record.pot === "buffer"
        ? {
            ...snapshot.buffer,
            amount: snapshot.buffer.amount + record.credited.amount,
          }
        : snapshot.buffer,
    reserved:
      record.pot === "reserved" &&
      record.commitmentId &&
      attempt.reservedPayeeMerchantId
        ? [
            ...snapshot.reserved,
            {
              commitmentId: record.commitmentId,
              payeeMerchantId: attempt.reservedPayeeMerchantId,
              amount: record.credited,
            },
          ]
        : snapshot.reserved,
    topups: [...snapshot.topups, record],
  };
  return checkInvariants(preview, now);
}

export interface MonitorAlert {
  event: "monitor.alert";
  data: { invariant: Invariant; detail: string };
}

export function runMonitor(
  snapshot: TreasurySnapshot,
  now: Date,
  freezeTreasurer: (alerts: MonitorAlert[]) => void,
): MonitorAlert[] {
  const alerts = checkInvariants(snapshot, now).map(
    ({ invariant, detail }) => ({
      event: "monitor.alert" as const,
      data: { invariant, detail },
    }),
  );
  if (alerts.length > 0) freezeTreasurer(alerts);
  return alerts;
}
