import { describe, expect, it } from "vitest";
import type {
  EditablePolicyLimits,
  PolicySnapshot,
  PreparedPolicyChange,
} from "./gateway";
import {
  parsePolicyDraft,
  policyChangeIsLoosening,
  policyDraft,
  policyReviewStillCurrent,
  validatePolicySnapshot,
  validatePreparedPolicyChange,
} from "./policyLimits";

const money = (amount: number) => ({ amount, currency: "CNY" as const });
const limits: EditablePolicyLimits = {
  per_payment_max: money(30000),
  daily_max: money(50000),
  monthly_max: money(100000),
  auto_approve_below: money(10000),
};
const snapshot: PolicySnapshot = {
  policy: {
    ...limits,
    schema: "policy.v1",
    user_id: "usr_owner",
    blocked_categories: [],
    new_merchant_requires_tap: true,
  },
  policy_hash: `sha256:${"a".repeat(64)}`,
  contract: {
    per_payment_max: money(30000),
    daily_max: money(50000),
    monthly_max: money(100000),
    spent_today: money(1200),
    spent_month: money(4500),
    block_number: "12345678901234567890",
    observed_at: "2026-10-19T12:00:00Z",
    next_daily_reset_at: "2026-10-20T00:00:00Z",
    next_monthly_reset_at: "2026-11-01T00:00:00Z",
  },
  sync_status: "consistent",
};

describe("owner policy limits", () => {
  it("parses exact fen and allows zero Green auto-approval", () => {
    const parsed = parsePolicyDraft({
      ...policyDraft(limits),
      auto_approve_below: "0",
      daily_max: "500.01",
    });
    expect(parsed.proposed?.daily_max.amount).toBe(50001);
    expect(parsed.proposed?.auto_approve_below.amount).toBe(0);
    expect(
      parsePolicyDraft({ ...policyDraft(limits), daily_max: "500.001" }).error,
    ).toMatch(/two decimal/);
    expect(
      parsePolicyDraft({ ...policyDraft(limits), daily_max: "200.00" }).error,
    ).toMatch(/per payment/);
  });

  it("requires proof for any raised field and rejects a false no-proof challenge", () => {
    const proposed = { ...limits, auto_approve_below: money(15000) };
    const change: PreparedPolicyChange = {
      change_id: "chg_one",
      action_hash: `sha256:${"b".repeat(64)}`,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      current: limits,
      proposed,
      requires_verification: false,
      simulated: true,
    };
    expect(policyChangeIsLoosening(limits, proposed)).toBe(true);
    expect(() =>
      validatePreparedPolicyChange(change, snapshot, proposed),
    ).toThrow(/does not match/);
    expect(() =>
      validatePreparedPolicyChange(
        { ...change, requires_verification: true },
        snapshot,
        proposed,
      ),
    ).not.toThrow();
  });

  it("rejects a claimed synchronized state when contract caps disagree", () => {
    const contract = snapshot.contract;
    if (!contract) throw new Error("Test contract missing");
    expect(() => validatePolicySnapshot(snapshot)).not.toThrow();
    expect(() =>
      validatePolicySnapshot({
        ...snapshot,
        contract: { ...contract, daily_max: money(40000) },
      }),
    ).toThrow(/disagree/);
  });

  it("invalidates a prepared owner review when policy, block, or sync state changes", () => {
    const hash = snapshot.policy_hash;
    const block = snapshot.contract?.block_number ?? "";
    expect(policyReviewStillCurrent(snapshot, hash, block)).toBe(true);
    expect(
      policyReviewStillCurrent(
        { ...snapshot, policy_hash: `sha256:${"d".repeat(64)}` },
        hash,
        block,
      ),
    ).toBe(false);
    expect(
      policyReviewStillCurrent(
        {
          ...snapshot,
          contract: snapshot.contract
            ? { ...snapshot.contract, block_number: "12345678901234567891" }
            : null,
        },
        hash,
        block,
      ),
    ).toBe(false);
    expect(
      policyReviewStillCurrent(
        { ...snapshot, sync_status: "change_pending" },
        hash,
        block,
      ),
    ).toBe(false);
    expect(policyReviewStillCurrent(null, hash, block)).toBe(false);
  });
});
