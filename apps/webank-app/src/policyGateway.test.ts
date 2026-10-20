import { describe, expect, it, vi } from "vitest";
import { createGatewayClient, type PolicySnapshot } from "./gateway";

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
const money = (amount: number) => ({ amount, currency: "CNY" as const });
const limits = {
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
    spent_today: money(0),
    spent_month: money(0),
    block_number: "9007199254740993",
    observed_at: "2026-10-19T12:00:00Z",
    next_daily_reset_at: "2026-10-20T00:00:00Z",
    next_monthly_reset_at: "2026-11-01T00:00:00Z",
  },
  sync_status: "consistent",
};

describe("owner policy Gateway client", () => {
  it("binds prepare to observed policy and contract, then submits exact simulated proof", async () => {
    const proposed = { ...limits, daily_max: money(60000) };
    const change = {
      change_id: "chg_one",
      action_hash: `sha256:${"b".repeat(64)}`,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      current: limits,
      proposed,
      requires_verification: true,
      simulated: true as const,
    };
    const fetcher = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path === "/v1/app/policy/prepare") return json(change);
        if (path === "/v1/app/policy") return json(snapshot);
        throw new Error(`Unexpected path ${path}`);
      },
    );
    const client = createGatewayClient(
      "http://127.0.0.1:3002",
      fetcher as unknown as typeof fetch,
      true,
    );
    await client.policy();
    const prepared = await client.preparePolicyChange(snapshot, proposed);
    expect(await client.completePolicyChange(prepared, true)).toEqual(snapshot);
    const prepare = fetcher.mock.calls[1];
    expect(JSON.parse(String(prepare?.[1]?.body))).toEqual({
      proposed,
      expected_policy_hash: snapshot.policy_hash,
      expected_contract_block: "9007199254740993",
      expected_contract_caps: {
        per_payment_max: money(30000),
        daily_max: money(50000),
        monthly_max: money(100000),
      },
    });
    const commit = fetcher.mock.calls[2];
    expect(commit?.[1]?.method).toBe("PUT");
    expect(commit?.[1]?.headers).toMatchObject({
      "Idempotency-Key": "policy-change-chg_one",
    });
    expect(JSON.parse(String(commit?.[1]?.body))).toEqual({
      change_id: "chg_one",
      verification: {
        action_hash: change.action_hash,
        device_signature: "simulated-local-approval",
      },
    });
  });

  it("omits simulated proof on a tighten and rejects proof requests outside local demo", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        json(snapshot),
    );
    const client = createGatewayClient(
      "http://127.0.0.1:3002",
      fetcher as unknown as typeof fetch,
      false,
    );
    const change = {
      change_id: "chg_tighten",
      action_hash: `sha256:${"c".repeat(64)}`,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      current: limits,
      proposed: { ...limits, auto_approve_below: money(0) },
      requires_verification: false,
      simulated: true as const,
    };
    await client.completePolicyChange(change, false);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      change_id: "chg_tighten",
    });
    expect(() =>
      client.completePolicyChange(
        { ...change, requires_verification: true },
        true,
      ),
    ).toThrow(/loopback local demo/);
  });
});
