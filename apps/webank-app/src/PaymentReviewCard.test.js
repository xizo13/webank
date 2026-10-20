import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => await import("react-native-web"));

import { PaymentReviewCard } from "./PaymentReviewCard";

describe("payment review card", () => {
  it("shows source-labelled intent beside verified signed order facts", () => {
    const review = {
      payload_hash: `sha256:${"a".repeat(64)}`,
      mandate_snapshot: {
        canonical_hash: `sha256:${"b".repeat(64)}`,
        mandate: {
          mandate_id: "mdt_one",
          agent_id: "agt_one",
          agent_key_binding: "p256:test-binding",
          description: "Black headphones",
          intent_level: "product",
          user_text: "Buy black headphones under ¥300",
          user_text_source: "agent_reported",
          constraints: [
            { type: "budget", max: { amount: 30000, currency: "CNY" } },
            {
              type: "execution_window",
              not_before: null,
              not_after: "2099-01-01T00:00:00Z",
            },
          ],
        },
      },
      signed_order: {
        payment_request_hash: `sha256:${"c".repeat(64)}`,
        merchant_id: "mch_shopA",
        merchant_legal_name: "Shop A Electronics Co., Ltd. (mock)",
        merchant_uscc: "MOCK00000000000001",
        order_id: "ord_one",
        line_items: [
          {
            type: "product",
            sku: "NOVA-Q3-BLK",
            gtin: "6901234567001",
            name: "Nova Quiet 3",
            condition: "new",
            variant: "Black",
            options: { colour: "Black" },
            qty: 1,
            unit_price: { amount: 27900, currency: "CNY" },
          },
          {
            type: "shipping",
            name: "Delivery",
            qty: 1,
            unit_price: { amount: 500, currency: "CNY" },
          },
        ],
        amount: { amount: 28400, currency: "CNY" },
        expires_at: "2099-01-01T00:00:00Z",
      },
      decision_checks: [{ name: "policy_licence", result: "step_up" }],
    };
    const html = renderToStaticMarkup(
      React.createElement(PaymentReviewCard, { review, secondsLeft: 90 }),
    );
    expect(html).toContain("User request, reported by the agent (unconfirmed)");
    expect(html).toContain("At this payment");
    expect(html).toContain("Show verification details");
    expect(html).not.toContain("p256:test-binding");
    expect(html).toContain("Buy black headphones under ¥300");
    expect(html).toContain("Shop A Electronics Co., Ltd. (mock)");
    expect(html).toContain("MOCK00000000000001");
    expect(html).toContain("6901234567001");
    expect(html).toContain("NOVA-Q3-BLK");
    expect(html).toContain("Shipping");
    expect(html).toContain("¥284.00");
    expect(html).toContain("90s left");
  });
});
