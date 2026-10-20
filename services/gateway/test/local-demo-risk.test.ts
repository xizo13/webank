import {
  AgentSchema,
  MandateSchema,
  PaymentRequestSchema,
} from "@webank/contracts";
import { describe, expect, it } from "vitest";
import { assessLocalDemoRisk } from "../src/local-demo-risk.js";

const agent = AgentSchema.parse({
  schema: "agent.v1",
  agent_id: "agt_risk",
  user_id: "usr_risk",
  display_name: "Risk test",
  provider: "test",
  public_key: "p256:risk-key",
  scopes: ["wallet:pay"],
  licence: {
    level: "GREEN",
    clean_purchases: 1,
    drills_passed: 1,
    drills_failed: 0,
    flags_30d: 0,
    reason: "Green",
    updated_at: "2026-10-19T00:00:00Z",
  },
  status: "active",
  created_at: "2026-10-19T00:00:00Z",
  last_used_at: "2026-10-19T00:00:00Z",
});
const mandate = MandateSchema.parse({
  schema: "mandate.v1",
  mandate_id: "mdt_risk",
  agent_id: agent.agent_id,
  agent_key_binding: agent.public_key,
  description: "Buy exact Nova Q3 Black",
  intent_level: "listing",
  user_text: "Buy exact Nova Q3 Black",
  user_text_source: "webank_screen",
  approval_timing: "payment",
  constraints: [
    { type: "amount_range", max: { amount: 6_000, currency: "CNY" } },
    { type: "categories", allowed: ["electronics"] },
    { type: "allowed_merchants", merchant_ids: ["mch_shopA"] },
    {
      type: "product",
      brand: "Nova",
      model: "Quiet 3",
      variant: "Black",
      condition: "new",
      gtin: "6901234567001",
      skus: ["NOVA-Q3-BLK"],
      qty: 1,
    },
    { type: "budget", max: { amount: 6_000, currency: "CNY" } },
    { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
    {
      type: "execution_window",
      not_before: null,
      not_after: "2026-10-20T00:00:00Z",
    },
  ],
  status: "pending_checkout",
  spent: { amount: 0, currency: "CNY" },
  occurrences: 0,
  in_flight_payment_id: null,
  approved_by: null,
  created_at: "2026-10-19T00:00:00Z",
});
const paymentRequest = PaymentRequestSchema.parse({
  schema: "payreq.v1",
  merchant_id: "mch_shopA",
  order_id: "ord_risk",
  amount: { amount: 5_000, currency: "CNY" },
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
      unit_price: { amount: 5_000, currency: "CNY" },
    },
    {
      type: "shipping",
      name: "Delivery",
      qty: 1,
      unit_price: { amount: 0, currency: "CNY" },
    },
  ],
  expires_at: "2026-10-20T00:00:00Z",
  nonce: "risk-nonce",
  merchant_sig: "signed-fixture",
});
const base = {
  agent,
  mandate,
  paymentRequest,
  merchant: {
    merchant_id: "mch_shopA",
    name: "Shop A",
    legal_name: "Shop A",
    uscc: "MOCK91440300TEST001",
    category: "electronics",
    first_seen: false,
    honeypot: false,
    public_key: `0x${"a".repeat(64)}` as const,
  },
  priceEvidence: [],
  historyKnown: true,
  earlierPaidOrdersHour: 0,
  earlierPaymentAttemptsHour: 0,
  ownerAutoApproveBelow: 10_000,
};

describe("local demo risk assessment", () => {
  it("passes only the exact low-value signed listing with complete durable history", () => {
    expect(assessLocalDemoRisk(base).result).toBe("pass");
  });
  it.each([
    ["missing history", { historyKnown: false }],
    [
      "wider intent",
      { mandate: { ...mandate, intent_level: "product" as const } },
    ],
    [
      "mislabelled trusted model",
      {
        mandate: {
          ...mandate,
          constraints: mandate.constraints.map((item) =>
            item.type === "product" ? { ...item, model: "Quiet 2" } : item,
          ),
        },
      },
    ],
    ["new merchant", { merchant: { ...base.merchant, first_seen: true } }],
    ["honeypot", { merchant: { ...base.merchant, honeypot: true } }],
    ["paid velocity", { earlierPaidOrdersHour: 2 }],
    ["attempt velocity", { earlierPaymentAttemptsHour: 3 }],
    [
      "agent price evidence",
      {
        priceEvidence: [
          {
            merchant_name: "Agent claim",
            price: { amount: 1_000, currency: "CNY" },
            seen_at: "2026-10-19T00:00:00Z",
          },
        ],
      },
    ],
    [
      "signed price above lock",
      {
        paymentRequest: {
          ...paymentRequest,
          amount: { amount: 7_000, currency: "CNY" },
        },
      },
    ],
  ])("steps up for %s", (_name, change) => {
    expect(assessLocalDemoRisk({ ...base, ...change })).toMatchObject({
      result: "step_up",
    });
  });
});
