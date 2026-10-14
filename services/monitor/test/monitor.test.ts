import type { Policy } from "@webank/contracts";
import { describe, expect, it } from "vitest";
import {
  checkFundingAttempt,
  checkInvariants,
  runMonitor,
  type TreasurySnapshot,
} from "../src/index.js";

const now = new Date("2026-10-27T21:00:00+08:00");

function snapshot(): TreasurySnapshot {
  const policy: Policy = {
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
    },
  };
  return {
    userId: "usr_demo",
    policy,
    mainBalance: { amount: 500000, currency: "CNY" },
    buffer: { amount: 0, currency: "CNY" },
    reserved: [],
    approvedCommitments: [
      {
        proposalId: "prp_demo",
        commitment: {
          schema: "commitment.v1",
          commitment_id: "cmt_claude",
          payee_merchant_id: "mch_anthropic",
          label: "Claude subscription",
          amount: { amount: 3000, currency: "USD" },
          frequency: "MONTHLY",
          next_due: "2026-10-28",
          source: "detected_from_settled",
          status: "active",
        },
      },
    ],
    approvedBufferTargets: [
      {
        proposalId: "prp_demo",
        target: { amount: 20000, currency: "CNY" },
      },
    ],
    topups: [],
    payments: [],
    approvedDecisionIds: [],
    treasurerFrozen: false,
  };
}

function topup(amount: number, at: string) {
  return {
    userId: "usr_demo",
    destinationUserId: "usr_demo",
    pot: "buffer" as const,
    debit: { amount, currency: "CNY" },
    credited: { amount, currency: "CNY" },
    at,
    proposalId: "prp_demo",
  };
}

describe("deterministic Treasurer watchdog", () => {
  it("accepts an approved commitment funded within 48 hours", () => {
    const state = snapshot();
    state.reserved.push({
      commitmentId: "cmt_claude",
      payeeMerchantId: "mch_anthropic",
      amount: { amount: 3000, currency: "USD" },
    });
    expect(checkInvariants(state, now)).toEqual([]);
    let freezeCalled = false;
    expect(
      runMonitor(state, now, () => {
        freezeCalled = true;
      }),
    ).toEqual([]);
    expect(freezeCalled).toBe(false);
  });

  it("freezes on a malformed restored snapshot without throwing or changing balances", () => {
    const malformed = {
      ...snapshot(),
      mainBalance: null,
    } as unknown as TreasurySnapshot;
    const before = structuredClone(malformed);
    let freezeCalled = false;
    expect(() =>
      runMonitor(malformed, now, () => {
        freezeCalled = true;
      }),
    ).not.toThrow();
    expect(freezeCalled).toBe(true);
    expect(runMonitor(malformed, now, () => {})).toEqual([
      {
        event: "monitor.alert",
        data: { invariant: "invalid_snapshot", detail: expect.any(String) },
      },
    ]);
    expect(malformed).toEqual(before);
  });

  it("fails closed on nonnumeric values, currency mismatch, and malformed nested records", () => {
    const malformedStates = [
      { ...snapshot(), mainBalance: { amount: "500000", currency: "CNY" } },
      { ...snapshot(), buffer: { amount: 0, currency: "USD" } },
      { ...snapshot(), policy: { ...snapshot().policy, treasurer: null } },
      { ...snapshot(), reserved: [null] },
      { ...snapshot(), topups: [{ debit: null }] },
    ];
    for (const malformed of malformedStates) {
      let freezeCalled = false;
      const alerts = runMonitor(
        malformed as unknown as TreasurySnapshot,
        now,
        () => {
          freezeCalled = true;
        },
      );
      expect(alerts[0]?.data.invariant).toBe("invalid_snapshot");
      expect(freezeCalled).toBe(true);
    }
    const fundingAttempt = {
      record: topup(100, now.toISOString()),
    };
    expect(
      checkFundingAttempt(
        malformedStates[0] as unknown as TreasurySnapshot,
        fundingAttempt,
        now,
      ),
    ).toMatchObject([{ invariant: "invalid_snapshot" }]);
    expect(
      checkFundingAttempt(
        snapshot(),
        {
          record: { ...fundingAttempt.record, credited: null },
        } as unknown as Parameters<typeof checkFundingAttempt>[1],
        now,
      ),
    ).toMatchObject([{ invariant: "unauthorized_funding" }]);
  });

  it("flags all six specified invariant classes", () => {
    const state = snapshot();
    state.reserved.push({
      commitmentId: "cmt_claude",
      payeeMerchantId: "mch_rogue",
      amount: { amount: 3001, currency: "USD" },
    });
    state.buffer.amount = 20001;
    state.mainBalance.amount = 299999;
    state.topups.push(topup(50001, now.toISOString()));
    state.topups.push(topup(100000, "2026-10-20T12:00:00+08:00"));
    state.payments.push({
      commitmentId: "cmt_claude",
      payeeMerchantId: "mch_rogue",
      amount: { amount: 3000, currency: "USD" },
      fromPot: "reserved",
      decisionId: "dec_missing",
      onChain: true,
    });
    const found = new Set(
      checkInvariants(state, now).map((item) => item.invariant),
    );
    expect(found).toEqual(
      new Set([
        "reserved_exceeds_approved_due",
        "buffer_exceeds_target",
        "daily_topup_ceiling",
        "monthly_topup_ceiling",
        "protected_main_balance",
        "reserved_payee_mismatch",
        "payment_without_approved_decision",
      ]),
    );
  });

  it("freezes Treasurer and emits an alert for a violation", () => {
    const state = snapshot();
    state.buffer.amount = 20001;
    let frozen = false;
    const alerts = runMonitor(state, now, () => {
      frozen = true;
    });
    expect(frozen).toBe(true);
    expect(alerts).toEqual([
      {
        event: "monitor.alert",
        data: {
          invariant: "buffer_exceeds_target",
          detail: expect.any(String),
        },
      },
    ]);
  });
});
