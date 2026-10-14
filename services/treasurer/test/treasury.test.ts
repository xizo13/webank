import type { Policy } from "@webank/contracts";
import { checkInvariants } from "@webank/monitor";
import { describe, expect, it } from "vitest";
import { type BankFxQuote, TreasuryExecutor } from "../src/executor.js";
import { mockClaudeHistory, propose } from "../src/proposals.js";

const now = new Date("2026-10-14T12:00:00+08:00");
const fundingTime = new Date("2026-10-27T21:00:00+08:00");

function policy(overrides: Partial<Policy["treasurer"]> = {}): Policy {
  return {
    schema: "policy.v1",
    user_id: "usr_demo",
    per_payment_max: { amount: 30000, currency: "CNY" },
    daily_max: { amount: 50000, currency: "CNY" },
    monthly_max: { amount: 100000, currency: "CNY" },
    auto_approve_below: { amount: 10000, currency: "CNY" },
    blocked_categories: [],
    new_merchant_requires_tap: true,
    treasurer: {
      enabled: true,
      buffer_target: { amount: 20000, currency: "CNY" },
      daily_topup_ceiling: { amount: 50000, currency: "CNY" },
      monthly_topup_ceiling: { amount: 150000, currency: "CNY" },
      protected_main_balance: { amount: 300000, currency: "CNY" },
      ...overrides,
    },
  };
}

function setup(initialMain = 500000, configured = policy()) {
  const executor = new TreasuryExecutor(
    "usr_demo",
    configured,
    { amount: initialMain, currency: "CNY" },
    {
      verifyUserApproval: async ({ evidence }) =>
        evidence === "gateway-verified-biometric",
      verifyBankFxQuote: async (quote) => quote.quoteId === "bank-quote-1",
      verifyPaymentDecision: async ({ evidence }) =>
        evidence === "gateway-approved-payment",
    },
  );
  const result = propose(mockClaudeHistory, [], configured, {
    consent: true,
    now,
    merchantLabels: { mch_anthropic: "Claude subscription" },
  });
  const proposal = result.proposals[0];
  const commitment = result.commitments[0];
  if (!proposal || !commitment)
    throw new Error("Mock subscription not detected");
  executor.submitProposal(proposal, [commitment]);
  const quote: BankFxQuote = {
    quoteId: "bank-quote-1",
    userId: "usr_demo",
    commitmentId: commitment.commitment_id,
    debit: { amount: 21000, currency: "CNY" },
    credit: { amount: 3000, currency: "USD" },
    expiresAt: "2026-10-27T22:00:00+08:00",
  };
  return { executor, proposal, commitment, quote };
}

describe("Treasurer proposal and simulated Demo 6 renewal", () => {
  it("detects only consented bank-settled monthly charges and proposes funding the day before", () => {
    expect(
      propose(mockClaudeHistory, [], policy(), { consent: false, now }),
    ).toEqual({
      commitments: [],
      proposals: [],
    });
    const { commitment, proposal } = setup();
    expect(commitment.payee_merchant_id).toBe("mch_anthropic");
    expect(commitment.amount).toEqual({ amount: 3000, currency: "USD" });
    expect(commitment.next_due).toBe("2026-10-28");
    expect(proposal.schedule).toEqual([
      {
        commitment_id: commitment.commitment_id,
        fund_at: "2026-10-27T21:00:00+08:00",
        amount: { amount: 3000, currency: "USD" },
      },
    ]);
    expect(() =>
      propose(
        [{ ...mockClaudeHistory[0], source: "agent_claim" }],
        [],
        policy(),
        { consent: true, now },
      ),
    ).toThrow();
  });

  it("requires a verified user approval, trusted FX quote, exact payee, and approved payment decision", async () => {
    const { executor, proposal, commitment, quote } = setup();
    expect(
      await executor.approveProposal(proposal.proposal_id, "ai-says-approved"),
    ).toBe(false);
    expect(
      await executor.fundScheduled(
        proposal.proposal_id,
        commitment.commitment_id,
        fundingTime,
        quote,
      ),
    ).toMatchObject({ status: "blocked" });
    expect(executor.getSnapshot().topups).toHaveLength(0);
  });

  it("funds $30 once, then pays the exact renewal from Reserved without touching Buffer", async () => {
    const { executor, proposal, commitment, quote } = setup();
    expect(
      await executor.approveProposal(
        proposal.proposal_id,
        "gateway-verified-biometric",
      ),
    ).toBe(true);
    expect(
      (
        await executor.fundScheduled(
          proposal.proposal_id,
          commitment.commitment_id,
          fundingTime,
        )
      ).status,
    ).toBe("blocked");
    expect(executor.getSnapshot().treasurerFrozen).toBe(false);
    const funded = await executor.fundScheduled(
      proposal.proposal_id,
      commitment.commitment_id,
      fundingTime,
      quote,
    );
    expect(funded).toMatchObject({
      status: "funded",
      simulationRef: expect.stringMatching(/^sim_/),
    });
    expect(
      (
        await executor.fundScheduled(
          proposal.proposal_id,
          commitment.commitment_id,
          fundingTime,
          quote,
        )
      ).status,
    ).toBe("already_funded");
    expect(executor.getSnapshot()).toMatchObject({
      mainBalance: { amount: 479000, currency: "CNY" },
      buffer: { amount: 0, currency: "CNY" },
      reserved: [
        {
          amount: { amount: 3000, currency: "USD" },
          payeeMerchantId: "mch_anthropic",
        },
      ],
    });
    expect(
      (
        await executor.payReserved({
          commitmentId: commitment.commitment_id,
          payeeMerchantId: "mch_anthropic",
          amount: { amount: 3000, currency: "USD" },
          decisionId: "dec_renewal",
          evidence: "gateway-approved-payment",
          at: fundingTime,
        })
      ).status,
    ).toBe("blocked");
    expect(
      (
        await executor.payReserved({
          commitmentId: commitment.commitment_id,
          payeeMerchantId: "mch_other",
          amount: { amount: 3000, currency: "USD" },
          decisionId: "dec_renewal",
          evidence: "gateway-approved-payment",
          at: new Date("2026-10-28T10:00:00+08:00"),
        })
      ).status,
    ).toBe("blocked");
    expect(
      (
        await executor.payReserved({
          commitmentId: commitment.commitment_id,
          payeeMerchantId: "mch_anthropic",
          amount: { amount: 3000, currency: "USD" },
          decisionId: "dec_renewal",
          evidence: "ai-says-approved",
          at: new Date("2026-10-28T10:00:00+08:00"),
        })
      ).status,
    ).toBe("blocked");
    expect(
      (
        await executor.payReserved({
          commitmentId: commitment.commitment_id,
          payeeMerchantId: "mch_anthropic",
          amount: { amount: 3000, currency: "USD" },
          decisionId: "dec_renewal",
          evidence: "gateway-approved-payment",
          at: new Date("2026-10-28T10:00:00+08:00"),
        })
      ).status,
    ).toBe("paid");
    expect(executor.getSnapshot().reserved[0]?.amount.amount).toBe(0);
    expect(executor.runMonitor(new Date("2026-10-28T10:00:00+08:00"))).toEqual(
      [],
    );
  });

  it("blocks a poisoned ¥2,000 recurrence and freezes Treasurer without moving money", async () => {
    const { executor, proposal } = setup();
    expect(
      await executor.approveProposal(
        proposal.proposal_id,
        "gateway-verified-biometric",
      ),
    ).toBe(true);
    const result = executor.inspectUntrustedFundingAttempt(
      {
        record: {
          userId: "usr_demo",
          destinationUserId: "usr_demo",
          pot: "reserved",
          debit: { amount: 200000, currency: "CNY" },
          credited: { amount: 200000, currency: "CNY" },
          at: fundingTime.toISOString(),
          proposalId: proposal.proposal_id,
          commitmentId: "cmt_poisoned",
        },
        reservedPayeeMerchantId: "mch_rogue",
      },
      fundingTime,
    );
    expect(result.status).toBe("blocked");
    expect(
      result.alerts?.some(
        (item) => item.data.invariant === "unauthorized_funding",
      ),
    ).toBe(true);
    expect(executor.getSnapshot()).toMatchObject({
      mainBalance: { amount: 500000, currency: "CNY" },
      treasurerFrozen: true,
      topups: [],
    });
  });

  it("prevents funding that breaches the protected main balance or daily ceiling", async () => {
    const protectedCase = setup(310000);
    await protectedCase.executor.approveProposal(
      protectedCase.proposal.proposal_id,
      "gateway-verified-biometric",
    );
    const blocked = await protectedCase.executor.fundScheduled(
      protectedCase.proposal.proposal_id,
      protectedCase.commitment.commitment_id,
      fundingTime,
      protectedCase.quote,
    );
    expect(
      blocked.alerts?.some(
        (item) => item.data.invariant === "protected_main_balance",
      ),
    ).toBe(true);
    expect(protectedCase.executor.getSnapshot().mainBalance.amount).toBe(
      310000,
    );

    const capped = setup(
      500000,
      policy({ daily_topup_ceiling: { amount: 20000, currency: "CNY" } }),
    );
    await capped.executor.approveProposal(
      capped.proposal.proposal_id,
      "gateway-verified-biometric",
    );
    const denied = await capped.executor.fundScheduled(
      capped.proposal.proposal_id,
      capped.commitment.commitment_id,
      fundingTime,
      capped.quote,
    );
    expect(
      denied.alerts?.some(
        (item) => item.data.invariant === "daily_topup_ceiling",
      ),
    ).toBe(true);
    expect(capped.executor.getSnapshot().topups).toHaveLength(0);

    const monthly = setup(
      500000,
      policy({ monthly_topup_ceiling: { amount: 20000, currency: "CNY" } }),
    );
    await monthly.executor.approveProposal(
      monthly.proposal.proposal_id,
      "gateway-verified-biometric",
    );
    const monthlyDenied = await monthly.executor.fundScheduled(
      monthly.proposal.proposal_id,
      monthly.commitment.commitment_id,
      fundingTime,
      monthly.quote,
    );
    expect(
      monthlyDenied.alerts?.some(
        (item) => item.data.invariant === "monthly_topup_ceiling",
      ),
    ).toBe(true);
    expect(monthly.executor.getSnapshot().topups).toHaveLength(0);
  });

  it("refills Buffer only to its approved target and reports a missing on-chain decision", async () => {
    const { executor, proposal } = setup();
    await executor.approveProposal(
      proposal.proposal_id,
      "gateway-verified-biometric",
    );
    expect(executor.fundBuffer(proposal.proposal_id, fundingTime).status).toBe(
      "funded",
    );
    expect(executor.fundBuffer(proposal.proposal_id, fundingTime).status).toBe(
      "already_funded",
    );
    expect(executor.getSnapshot().buffer.amount).toBe(20000);
    const snapshot = executor.getSnapshot();
    snapshot.payments.push({
      payeeMerchantId: "mch_anthropic",
      amount: { amount: 100, currency: "CNY" },
      fromPot: "buffer",
      decisionId: "dec_missing",
      onChain: true,
    });
    expect(
      checkInvariants(snapshot, fundingTime).some(
        (item) => item.invariant === "payment_without_approved_decision",
      ),
    ).toBe(true);
  });

  it("does not double-fund or double-pay under concurrent retries", async () => {
    const { executor, proposal, commitment, quote } = setup();
    await executor.approveProposal(
      proposal.proposal_id,
      "gateway-verified-biometric",
    );
    const funding = await Promise.all([
      executor.fundScheduled(
        proposal.proposal_id,
        commitment.commitment_id,
        fundingTime,
        quote,
      ),
      executor.fundScheduled(
        proposal.proposal_id,
        commitment.commitment_id,
        fundingTime,
        quote,
      ),
    ]);
    expect(funding.map((item) => item.status).sort()).toEqual([
      "already_funded",
      "funded",
    ]);
    expect(executor.getSnapshot().mainBalance.amount).toBe(479000);
    const payment = {
      commitmentId: commitment.commitment_id,
      payeeMerchantId: "mch_anthropic",
      amount: { amount: 3000, currency: "USD" },
      decisionId: "dec_retry",
      evidence: "gateway-approved-payment",
      at: new Date("2026-10-28T10:00:00+08:00"),
    };
    const payments = await Promise.all([
      executor.payReserved(payment),
      executor.payReserved(payment),
    ]);
    expect(payments.map((item) => item.status).sort()).toEqual([
      "blocked",
      "paid",
    ]);
    expect(executor.getSnapshot().payments).toHaveLength(1);
  });

  it("rejects a changed proposal and catches duplicate Reserved accumulation", async () => {
    const { executor, proposal, commitment, quote } = setup();
    const changed = {
      ...proposal,
      proposal_id: "prp_changed",
      schedule: [
        {
          ...proposal.schedule[0],
          amount: { amount: 200000, currency: "CNY" },
        },
      ],
    };
    expect(() => executor.submitProposal(changed, [commitment])).toThrow();
    await executor.approveProposal(
      proposal.proposal_id,
      "gateway-verified-biometric",
    );
    await executor.fundScheduled(
      proposal.proposal_id,
      commitment.commitment_id,
      fundingTime,
      quote,
    );
    const snapshot = executor.getSnapshot();
    const reserved = snapshot.reserved[0];
    if (!reserved) throw new Error("Expected reserved balance");
    snapshot.reserved.push({ ...reserved });
    expect(
      checkInvariants(snapshot, fundingTime).some(
        (item) => item.invariant === "reserved_exceeds_approved_due",
      ),
    ).toBe(true);
  });
});
