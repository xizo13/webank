import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => await import("react-native-web"));

import { PolicyLimitsPanel } from "./PolicyLimitsPanel";

const money = (amount) => ({ amount, currency: "CNY" });
const snapshot = {
  policy: {
    schema: "policy.v1",
    user_id: "usr_owner",
    per_payment_max: money(30000),
    daily_max: money(50000),
    monthly_max: money(100000),
    auto_approve_below: money(10000),
    blocked_categories: [],
    new_merchant_requires_tap: true,
  },
  policy_hash: `sha256:${"a".repeat(64)}`,
  contract: {
    per_payment_max: money(30000),
    daily_max: money(50000),
    monthly_max: money(100000),
    spent_today: money(1300),
    spent_month: money(2200),
    block_number: "1234",
    observed_at: "2026-10-19T12:00:00Z",
    next_daily_reset_at: "2026-10-20T00:00:00Z",
    next_monthly_reset_at: "2026-11-01T00:00:00Z",
  },
  sync_status: "consistent",
};

describe("live Wallet limits panel", () => {
  it("shows Gateway and contract caps, spend, local reset labels, and Green rule", () => {
    const html = renderToStaticMarkup(
      React.createElement(PolicyLimitsPanel, {
        snapshot,
        error: "",
        message: "",
        busy: false,
        onRefresh: () => {},
        onSave: () => {},
      }),
    );
    expect(html).toContain("Current Gateway policy");
    expect(html).toContain("Observed AgentWallet contract caps");
    expect(html).toContain("Spent today");
    expect(html).toContain("Next daily reset (local time)");
    expect(html).toContain("Next monthly reset (local time)");
    expect(html).toContain("Amber purchases always need your approval");
    expect(html).toContain("Edit spending limits");
  });

  it("does not present a mismatched Gateway limit as confirmed active", () => {
    const html = renderToStaticMarkup(
      React.createElement(PolicyLimitsPanel, {
        snapshot: { ...snapshot, sync_status: "mismatch" },
        error: "",
        message: "",
        busy: false,
        onRefresh: () => {},
        onSave: () => {},
      }),
    );
    expect(html).toContain("Gateway policy - not confirmed active");
    expect(html).toContain("Agent spending is blocked");
    expect(html).toContain('aria-disabled="true"');
  });
});
