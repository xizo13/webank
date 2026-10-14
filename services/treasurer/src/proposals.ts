import { createHash } from "node:crypto";
import {
  type Commitment,
  CommitmentSchema,
  type FundingProposal,
  FundingProposalSchema,
  MerchantIdSchema,
  MoneySchema,
  PolicySchema,
  TimestampSchema,
  UserIdSchema,
} from "@webank/contracts";
import { z } from "zod";

export const SettledTransactionSchema = z
  .object({
    settlement_id: z.string().regex(/^stl_[A-Za-z0-9_-]+$/),
    user_id: UserIdSchema,
    payee_merchant_id: MerchantIdSchema,
    amount: MoneySchema.refine((money) => money.amount > 0),
    settled_at: TimestampSchema,
    source: z.literal("bank_settled_ledger"),
    status: z.literal("settled"),
  })
  .strict();
export type SettledTransaction = z.infer<typeof SettledTransactionSchema>;

function hashId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function shanghaiDay(value: string): string {
  return new Date(Date.parse(value) + 8 * 3_600_000).toISOString().slice(0, 10);
}

function addMonth(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) throw new Error("Invalid settlement date");
  const nextMonth = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(
    Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth() + 1, 0),
  ).getUTCDate();
  nextMonth.setUTCDate(Math.min(date, lastDay));
  return nextMonth.toISOString().slice(0, 10);
}

function previousDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function monthlyPattern(items: SettledTransaction[]): boolean {
  if (items.length < 3) return false;
  const last = items.slice(-3);
  for (let index = 1; index < last.length; index++) {
    const prior = last[index - 1];
    const current = last[index];
    if (!prior || !current) return false;
    const priorDay = shanghaiDay(prior.settled_at);
    const currentDay = shanghaiDay(current.settled_at);
    const expected = Date.parse(`${addMonth(priorDay)}T00:00:00Z`);
    const actual = Date.parse(`${currentDay}T00:00:00Z`);
    if (Math.abs(expected - actual) > 2 * 86_400_000) return false;
  }
  return true;
}

/** Only structured, bank-settled ledger rows may enter recurrence detection. */
export function propose(
  rawTransactions: unknown[],
  rawCurrentCommitments: unknown[],
  rawPolicy: unknown,
  options: {
    consent: boolean;
    now: Date;
    merchantLabels?: Record<string, string>;
  },
): { commitments: Commitment[]; proposals: FundingProposal[] } {
  if (!options.consent) return { commitments: [], proposals: [] };
  const policy = PolicySchema.parse(rawPolicy);
  if (!policy.treasurer.enabled || !Number.isFinite(options.now.getTime()))
    return { commitments: [], proposals: [] };
  const transactions = z.array(SettledTransactionSchema).parse(rawTransactions);
  const current = z.array(CommitmentSchema).parse(rawCurrentCommitments);
  if (transactions.some((item) => item.user_id !== policy.user_id))
    throw new Error("Cross-user settled history is forbidden");
  const grouped = new Map<string, SettledTransaction[]>();
  for (const transaction of transactions) {
    const key = `${transaction.payee_merchant_id}|${transaction.amount.currency}|${transaction.amount.amount}`;
    const group = grouped.get(key) ?? [];
    group.push(transaction);
    grouped.set(key, group);
  }
  const commitments: Commitment[] = [];
  const schedule: FundingProposal["schedule"] = [];
  const today = shanghaiDay(options.now.toISOString());
  for (const [key, unsorted] of grouped) {
    const items = [...unsorted].sort(
      (a, b) => Date.parse(a.settled_at) - Date.parse(b.settled_at),
    );
    if (!monthlyPattern(items)) continue;
    const last = items.at(-1);
    if (!last) continue;
    const identity = hashId("cmt", `${policy.user_id}|${key}`);
    if (
      current.some(
        (item) =>
          item.commitment_id === identity && item.status !== "cancelled",
      )
    )
      continue;
    let nextDue = addMonth(shanghaiDay(last.settled_at));
    while (nextDue <= today) nextDue = addMonth(nextDue);
    const label =
      options.merchantLabels?.[last.payee_merchant_id] ??
      last.payee_merchant_id;
    const commitment = CommitmentSchema.parse({
      schema: "commitment.v1",
      commitment_id: identity,
      payee_merchant_id: last.payee_merchant_id,
      label,
      amount: last.amount,
      frequency: "MONTHLY",
      next_due: nextDue,
      source: "detected_from_settled",
      status: "proposed",
    });
    commitments.push(commitment);
    schedule.push({
      commitment_id: identity,
      fund_at: `${previousDay(nextDue)}T21:00:00+08:00`,
      amount: last.amount,
    });
  }
  if (commitments.length === 0) return { commitments, proposals: [] };
  const commitmentIds = commitments.map((item) => item.commitment_id);
  const proposal = FundingProposalSchema.parse({
    schema: "funding_proposal.v1",
    proposal_id: hashId(
      "prp",
      `${policy.user_id}|${commitmentIds.join("|")}|${schedule.map((item) => item.fund_at).join("|")}`,
    ),
    commitments: commitmentIds,
    buffer_target: policy.treasurer.buffer_target,
    schedule,
    rationale: `Detected ${commitments.length} monthly commitment(s) from three bank-settled charges per payee and exact amount. User approval is required before funding.`,
    status: "pending_user",
  });
  return { commitments, proposals: [proposal] };
}

export const mockClaudeHistory: SettledTransaction[] = [
  "2026-07-28T08:30:00+08:00",
  "2026-08-28T08:30:00+08:00",
  "2026-09-28T08:30:00+08:00",
].map((settled_at, index) => ({
  settlement_id: `stl_claude_${index + 1}`,
  user_id: "usr_demo",
  payee_merchant_id: "mch_anthropic",
  amount: { amount: 3000, currency: "USD" },
  settled_at,
  source: "bank_settled_ledger",
  status: "settled",
}));
