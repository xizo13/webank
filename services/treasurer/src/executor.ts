import { createHash } from "node:crypto";
import {
  type Commitment,
  CommitmentSchema,
  type FundingProposal,
  FundingProposalSchema,
  type Money,
  MoneySchema,
  PolicySchema,
} from "@webank/contracts";
import {
  checkFundingAttempt,
  type FundingAttempt,
  type FundingRecord,
  type MonitorAlert,
  type PaymentEvidence,
  runMonitor,
  type TreasurySnapshot,
  type Violation,
} from "@webank/monitor";

export interface BankFxQuote {
  quoteId: string;
  userId: string;
  commitmentId: string;
  debit: Money;
  credit: Money;
  expiresAt: string;
}

export interface TreasuryTrustPorts {
  /** Gateway verifies an action-bound biometric signature before returning true. */
  verifyUserApproval(input: {
    userId: string;
    proposalId: string;
    proposalHash: string;
    evidence: unknown;
  }): Promise<boolean>;
  /** Core banking verifies the quote; no AI-provided exchange rate is accepted. */
  verifyBankFxQuote(quote: BankFxQuote): Promise<boolean>;
  /** Gateway verifies that this exact renewal payment had an APPROVED decision. */
  verifyPaymentDecision(input: {
    userId: string;
    decisionId: string;
    commitmentId: string;
    payeeMerchantId: string;
    amount: Money;
    evidence: unknown;
  }): Promise<boolean>;
}

export interface FundingResult {
  status: "funded" | "blocked" | "already_funded";
  simulationRef?: string;
  record?: FundingRecord;
  alerts?: MonitorAlert[];
  reason?: string;
}

export interface PaymentResult {
  status: "paid" | "blocked";
  simulationRef?: string;
  reason?: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function proposalHash(proposal: FundingProposal): string {
  return `sha256:${createHash("sha256").update(canonical(proposal)).digest("hex")}`;
}

function simulationRef(value: string): string {
  return `sim_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

/** In-memory demo ledger.  All transfers here are simulations, never chain transactions. */
export class TreasuryExecutor {
  private readonly pending = new Map<
    string,
    { proposal: FundingProposal; commitments: Commitment[] }
  >();
  private readonly approved = new Map<string, FundingProposal>();
  private readonly funded = new Set<string>();
  private readonly alerts: MonitorAlert[] = [];
  private readonly snapshot: TreasurySnapshot;

  constructor(
    userId: string,
    rawPolicy: unknown,
    rawMainBalance: unknown,
    private readonly ports: TreasuryTrustPorts,
  ) {
    const policy = PolicySchema.parse(rawPolicy);
    const mainBalance = MoneySchema.parse(rawMainBalance);
    if (
      policy.user_id !== userId ||
      mainBalance.currency !== policy.treasurer.protected_main_balance.currency
    )
      throw new Error("Treasury owner or main-balance currency mismatch");
    this.snapshot = {
      userId,
      policy,
      mainBalance: { ...mainBalance },
      buffer: { amount: 0, currency: policy.treasurer.buffer_target.currency },
      reserved: [],
      approvedCommitments: [],
      approvedBufferTargets: [],
      topups: [],
      payments: [],
      approvedDecisionIds: [],
      treasurerFrozen: false,
    };
  }

  getSnapshot(): TreasurySnapshot {
    return structuredClone(this.snapshot);
  }

  getAlerts(): MonitorAlert[] {
    return structuredClone(this.alerts);
  }

  submitProposal(rawProposal: unknown, rawCommitments: unknown[]): void {
    const proposal = FundingProposalSchema.parse(rawProposal);
    const commitments = rawCommitments.map((item) =>
      CommitmentSchema.parse(item),
    );
    if (
      proposal.status !== "pending_user" ||
      this.pending.has(proposal.proposal_id) ||
      this.approved.has(proposal.proposal_id)
    )
      throw new Error("Proposal is not a new pending request");
    if (
      proposal.buffer_target.currency !==
        this.snapshot.policy.treasurer.buffer_target.currency ||
      proposal.buffer_target.amount >
        this.snapshot.policy.treasurer.buffer_target.amount
    )
      throw new Error("Proposal exceeds policy buffer target");
    const commitmentIds = new Set(
      commitments.map((item) => item.commitment_id),
    );
    if (
      commitmentIds.size !== commitments.length ||
      proposal.commitments.length !== commitmentIds.size ||
      proposal.commitments.some((id) => !commitmentIds.has(id)) ||
      proposal.schedule.length !== commitmentIds.size
    )
      throw new Error("Proposal commitments and schedule do not match");
    for (const entry of proposal.schedule) {
      const commitment = commitments.find(
        (item) => item.commitment_id === entry.commitment_id,
      );
      if (
        commitment?.status !== "proposed" ||
        entry.amount.amount !== commitment.amount.amount ||
        entry.amount.currency !== commitment.amount.currency ||
        proposal.schedule.filter(
          (item) => item.commitment_id === entry.commitment_id,
        ).length !== 1
      )
        throw new Error(
          "Schedule is not bound to the exact proposed commitment",
        );
      const dueStart = Date.parse(`${commitment.next_due}T00:00:00+08:00`);
      const fundTime = Date.parse(entry.fund_at);
      if (
        !Number.isFinite(dueStart) ||
        !Number.isFinite(fundTime) ||
        fundTime < dueStart - 48 * 3_600_000 ||
        fundTime >= dueStart
      )
        throw new Error(
          "Funding must be scheduled within 48 hours before due date",
        );
    }
    this.pending.set(proposal.proposal_id, { proposal, commitments });
  }

  async approveProposal(
    proposalId: string,
    evidence: unknown,
  ): Promise<boolean> {
    const pending = this.pending.get(proposalId);
    if (!pending || this.snapshot.treasurerFrozen) return false;
    const approved = await this.ports.verifyUserApproval({
      userId: this.snapshot.userId,
      proposalId,
      proposalHash: proposalHash(pending.proposal),
      evidence,
    });
    if (!approved) return false;
    if (
      this.pending.get(proposalId) !== pending ||
      this.snapshot.treasurerFrozen
    )
      return false;
    const proposal: FundingProposal = {
      ...pending.proposal,
      status: "approved",
    };
    this.approved.set(proposalId, proposal);
    this.snapshot.approvedBufferTargets.push({
      proposalId,
      target: { ...proposal.buffer_target },
    });
    for (const commitment of pending.commitments) {
      this.snapshot.approvedCommitments.push({
        commitment: { ...commitment, status: "active" },
        proposalId,
      });
    }
    this.pending.delete(proposalId);
    return true;
  }

  private freeze(violations: Violation[]): MonitorAlert[] {
    const alerts = violations.map(({ invariant, detail }) => ({
      event: "monitor.alert" as const,
      data: { invariant, detail },
    }));
    this.snapshot.treasurerFrozen = true;
    this.alerts.push(...alerts);
    return alerts;
  }

  private blocked(reason: string, violations?: Violation[]): FundingResult {
    return {
      status: "blocked",
      reason,
      alerts: this.freeze(
        violations ?? [{ invariant: "unauthorized_funding", detail: reason }],
      ),
    };
  }

  runMonitor(now: Date): MonitorAlert[] {
    const alerts = runMonitor(this.snapshot, now, (items) => {
      this.snapshot.treasurerFrozen = true;
      this.alerts.push(...items);
    });
    return alerts;
  }

  async fundScheduled(
    proposalId: string,
    commitmentId: string,
    now: Date,
    quote?: BankFxQuote,
  ): Promise<FundingResult> {
    if (!Number.isFinite(now.getTime()))
      return this.blocked("Invalid funding time");
    const idempotencyKey = `${proposalId}|${commitmentId}`;
    if (this.funded.has(idempotencyKey)) return { status: "already_funded" };
    const proposal = this.approved.get(proposalId);
    const entry = proposal?.schedule.find(
      (item) => item.commitment_id === commitmentId,
    );
    const approved = this.snapshot.approvedCommitments.find(
      (item) =>
        item.proposalId === proposalId &&
        item.commitment.commitment_id === commitmentId,
    );
    if (!proposal || !entry || !approved)
      return this.blocked(
        "No exact user-approved schedule for attempted funding",
      );
    const commitment = approved.commitment;
    const dueEnd =
      Date.parse(`${commitment.next_due}T00:00:00+08:00`) + 86_400_000;
    if (now.getTime() < Date.parse(entry.fund_at) || now.getTime() >= dueEnd)
      return { status: "blocked", reason: "Outside approved funding window" };
    if (
      this.snapshot.treasurerFrozen ||
      !this.snapshot.policy.treasurer.enabled
    )
      return { status: "blocked", reason: "Treasurer is frozen or disabled" };
    let debit = entry.amount;
    if (entry.amount.currency !== this.snapshot.mainBalance.currency) {
      if (
        !quote?.quoteId ||
        quote.userId !== this.snapshot.userId ||
        quote.commitmentId !== commitmentId ||
        quote.credit.amount !== entry.amount.amount ||
        quote.credit.currency !== entry.amount.currency ||
        quote.debit.currency !== this.snapshot.mainBalance.currency ||
        !Number.isFinite(Date.parse(quote.expiresAt)) ||
        Date.parse(quote.expiresAt) < now.getTime() ||
        !(await this.ports.verifyBankFxQuote(quote))
      )
        return {
          status: "blocked",
          reason: "Missing or invalid trusted bank FX quote",
        };
      debit = MoneySchema.parse(quote.debit);
    } else if (quote) {
      return {
        status: "blocked",
        reason: "Unexpected FX quote for same-currency funding",
      };
    }
    if (this.funded.has(idempotencyKey)) return { status: "already_funded" };
    const record: FundingRecord = {
      userId: this.snapshot.userId,
      destinationUserId: this.snapshot.userId,
      pot: "reserved",
      debit,
      credited: entry.amount,
      at: now.toISOString(),
      proposalId,
      commitmentId,
    };
    return this.commitFunding(
      { record, reservedPayeeMerchantId: commitment.payee_merchant_id },
      now,
      idempotencyKey,
    );
  }

  fundBuffer(proposalId: string, now: Date): FundingResult {
    if (!Number.isFinite(now.getTime()))
      return { status: "blocked", reason: "Invalid funding time" };
    const proposal = this.approved.get(proposalId);
    if (
      !proposal ||
      this.snapshot.treasurerFrozen ||
      !this.snapshot.policy.treasurer.enabled
    )
      return {
        status: "blocked",
        reason: "No approved buffer target or Treasurer disabled",
      };
    const refill = proposal.buffer_target.amount - this.snapshot.buffer.amount;
    if (refill <= 0) return { status: "already_funded" };
    const amount = {
      amount: refill,
      currency: proposal.buffer_target.currency,
    };
    const record: FundingRecord = {
      userId: this.snapshot.userId,
      destinationUserId: this.snapshot.userId,
      pot: "buffer",
      debit: amount,
      credited: amount,
      at: now.toISOString(),
      proposalId,
    };
    return this.commitFunding({ record }, now);
  }

  /** Inspect an untrusted scheduler instruction; only typed methods can commit. */
  inspectUntrustedFundingAttempt(
    attempt: FundingAttempt,
    now: Date,
  ): FundingResult {
    if (!this.approved.has(attempt.record.proposalId))
      return this.blocked(
        "Funding refers to a proposal without verified user approval",
      );
    const violations = checkFundingAttempt(this.snapshot, attempt, now);
    if (violations.length > 0)
      return this.blocked("Invariant monitor blocked funding", violations);
    return {
      status: "blocked",
      reason:
        "Raw scheduler instructions cannot execute; use an approved schedule",
    };
  }

  private commitFunding(
    attempt: FundingAttempt,
    now: Date,
    idempotencyKey?: string,
  ): FundingResult {
    const violations = checkFundingAttempt(this.snapshot, attempt, now);
    if (violations.length > 0)
      return this.blocked("Invariant monitor blocked funding", violations);
    const record = attempt.record;
    if (
      record.pot === "reserved" &&
      (!record.commitmentId || !attempt.reservedPayeeMerchantId)
    )
      return this.blocked("Missing reserved commitment or payee");
    this.snapshot.mainBalance.amount -= record.debit.amount;
    if (record.pot === "buffer")
      this.snapshot.buffer.amount += record.credited.amount;
    else {
      this.snapshot.reserved.push({
        commitmentId: record.commitmentId as string,
        payeeMerchantId: attempt.reservedPayeeMerchantId as string,
        amount: { ...record.credited },
      });
    }
    this.snapshot.topups.push(structuredClone(record));
    if (idempotencyKey) this.funded.add(idempotencyKey);
    return {
      status: "funded",
      record,
      simulationRef: simulationRef(canonical(record)),
    };
  }

  async payReserved(input: {
    commitmentId: string;
    payeeMerchantId: string;
    amount: Money;
    decisionId: string;
    evidence: unknown;
    at: Date;
  }): Promise<PaymentResult> {
    const amount = MoneySchema.safeParse(input.amount);
    const approved = this.snapshot.approvedCommitments.find(
      (item) => item.commitment.commitment_id === input.commitmentId,
    );
    const pot = this.snapshot.reserved.find(
      (item) => item.commitmentId === input.commitmentId,
    );
    const dueStart = approved
      ? Date.parse(`${approved.commitment.next_due}T00:00:00+08:00`)
      : Number.NaN;
    if (
      !(input.at instanceof Date) ||
      !Number.isFinite(input.at.getTime()) ||
      !Number.isFinite(dueStart) ||
      input.at.getTime() < dueStart ||
      input.at.getTime() >= dueStart + 86_400_000 ||
      !amount.success ||
      amount.data.amount <= 0 ||
      !approved ||
      !pot ||
      input.payeeMerchantId !== approved.commitment.payee_merchant_id ||
      pot.payeeMerchantId !== input.payeeMerchantId ||
      amount.data.currency !== pot.amount.currency ||
      amount.data.amount !== approved.commitment.amount.amount ||
      amount.data.amount > pot.amount.amount
    )
      return {
        status: "blocked",
        reason:
          "Reserved funds do not match approved commitment, payee, amount, and due date",
      };
    if (
      !(await this.ports.verifyPaymentDecision({
        userId: this.snapshot.userId,
        decisionId: input.decisionId,
        commitmentId: input.commitmentId,
        payeeMerchantId: input.payeeMerchantId,
        amount: amount.data,
        evidence: input.evidence,
      }))
    )
      return {
        status: "blocked",
        reason: "No verified APPROVED payment decision",
      };
    if (pot.amount.amount < amount.data.amount)
      return {
        status: "blocked",
        reason: "Reserved balance was already spent",
      };
    pot.amount.amount -= amount.data.amount;
    this.snapshot.approvedDecisionIds.push(input.decisionId);
    const payment: PaymentEvidence = {
      commitmentId: input.commitmentId,
      payeeMerchantId: input.payeeMerchantId,
      amount: amount.data,
      fromPot: "reserved",
      decisionId: input.decisionId,
      onChain: false,
    };
    this.snapshot.payments.push(payment);
    return { status: "paid", simulationRef: simulationRef(canonical(payment)) };
  }
}
