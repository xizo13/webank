import { describe, expect, it } from "vitest";
import type { Approval } from "./flow";
import {
  parsePaymentReview,
  reviewConstraintRows,
  reviewMatchesApproval,
} from "./paymentReview";

const hash = (character: string) => `sha256:${character.repeat(64)}`;
const expiresAt = "2099-01-01T00:03:00Z";

function reviewFixture() {
  return {
    schema: "payment_review.v1",
    status: "pending",
    approval_id: "apr_review",
    payment_id: "pay_review",
    payload_hash: hash("a"),
    expires_at: expiresAt,
    mandate_snapshot: {
      canonical_hash: hash("b"),
      mandate: {
        mandate_id: "mdt_review",
        agent_id: "agt_buyer",
        agent_key_binding: "p256:test-binding",
        description: "Black headphones",
        intent_level: "product",
        user_text: "Buy the black headphones under ¥300",
        user_text_source: "agent_reported",
        approval_timing: "payment",
        constraints: [
          { type: "amount_range", max: { amount: 30000, currency: "CNY" } },
          { type: "budget", max: { amount: 30000, currency: "CNY" } },
          { type: "categories", allowed: ["electronics"] },
          { type: "allowed_merchants", merchant_ids: ["mch_shopA"] },
          {
            type: "product",
            brand: "Nova",
            model: "Quiet 3",
            variant: "Black",
            condition: "new",
            gtin: "6901234567001",
            skus: null,
            qty: 1,
          },
          { type: "must_have", attributes: ["wireless"] },
          { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
          { type: "execution_window", not_before: null, not_after: expiresAt },
        ],
      },
    },
    signed_order: {
      payment_request_hash: hash("c"),
      merchant_id: "mch_shopA",
      merchant_legal_name: "Shop A Electronics Co., Ltd. (mock)",
      merchant_uscc: "MOCK00000000000001",
      order_id: "ord_review",
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
      expires_at: expiresAt,
    },
    decision_checks: [
      { name: "mandate", result: "pass" },
      {
        name: "policy_licence",
        result: "step_up",
        detail: { reason: "first_payment_requires_number_match" },
      },
    ],
  };
}

const approval: Approval = {
  approval_id: "apr_review",
  kind: "payment",
  subject_id: "pay_review",
  title: "Payment request",
  lines: ["Review payment"],
  payload_hash: hash("a"),
  review_schema: "payment_review.v1",
  level: "zero_trust",
  expires_at: expiresAt,
  status: "pending",
};

describe("composite payment review", () => {
  it("presents the full locked intent and keeps its own deadline separate from the signed order", () => {
    const review = parsePaymentReview(reviewFixture());
    const rows = reviewConstraintRows(review);
    expect(rows).toContainEqual({ label: "Budget", value: "¥300.00" });
    expect(rows).toContainEqual({
      label: "Locked GTIN",
      value: "6901234567001",
    });
    expect(rows).toContainEqual({ label: "Merchant lock", value: "mch_shopA" });
    expect(rows).toContainEqual({ label: "Intent expires", value: expiresAt });
    expect(review.signed_order.line_items).toHaveLength(2);
    expect(review.signed_order.amount.amount).toBe(28400);
    expect(
      reviewMatchesApproval(
        review,
        approval,
        Date.parse("2099-01-01T00:00:00Z"),
      ),
    ).toBe(true);
  });

  it("fails closed for a changed hash, payment ID, expired review, or missing signed details", () => {
    const review = parsePaymentReview(reviewFixture());
    expect(
      reviewMatchesApproval(
        review,
        { ...approval, payload_hash: hash("d") },
        Date.parse("2099-01-01T00:00:00Z"),
      ),
    ).toBe(false);
    expect(
      reviewMatchesApproval(
        review,
        { ...approval, subject_id: "pay_other" },
        Date.parse("2099-01-01T00:00:00Z"),
      ),
    ).toBe(false);
    expect(reviewMatchesApproval(review, approval, Date.parse(expiresAt))).toBe(
      false,
    );
    const missingPayee = reviewFixture();
    missingPayee.signed_order.merchant_legal_name = "";
    expect(() => parsePaymentReview(missingPayee)).toThrow("incomplete");
    const unknownLock = reviewFixture();
    unknownLock.mandate_snapshot.mandate.constraints.push({
      type: "unrecognized",
    } as never);
    expect(() => parsePaymentReview(unknownLock)).toThrow("incomplete");
    const mismatchedTotal = reviewFixture();
    mismatchedTotal.signed_order.amount.amount = 28300;
    expect(() => parsePaymentReview(mismatchedTotal)).toThrow("incomplete");
    const noShipping = reviewFixture();
    noShipping.signed_order.line_items.pop();
    expect(() => parsePaymentReview(noShipping)).toThrow("incomplete");
  });
});
