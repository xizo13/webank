import { describe, expect, it } from "vitest";
import {
  AppEventSchema,
  ApprovalDecisionRequestSchema,
  ApprovalSchema,
  approvalExpiresAt,
  CreateMandateRequestSchema,
  CreatePaymentRequestSchema,
  DEFAULT_APPROVAL_TTL_SECONDS,
  DecisionSchema,
  DeviceAuthorizationResponseSchema,
  decodePaymentRequestUri,
  EverydayVerificationSchema,
  encodePaymentRequestUri,
  MandateSchema,
  MoneySchema,
  PaymentRequestSchema,
  PaymentStatusResponseSchema,
  PaymentSubmissionResponseSchema,
  ReceiptSchema,
  VerificationSchema,
  ZeroTrustVerificationSchema,
} from "../src/index.js";

const timestamp = "2026-10-13T14:22:05+08:00";
const tx = `0x${"a".repeat(64)}`;
const hash = `sha256:${"b".repeat(64)}`;
const approval = {
  schema: "approval.v1",
  approval_id: "apr_31cd",
  kind: "payment",
  subject_id: "pay_1a2b",
  title: "Claude wants to pay ¥279",
  lines: ["To: Shop A Electronics"],
  payload_hash: hash,
  level: "zero_trust",
  expires_at: "2026-10-13T06:25:05Z",
  status: "pending",
};

const constraints = [
  { type: "amount_range", max: { amount: 30_000, currency: "CNY" } },
  { type: "categories", allowed: ["electronics"] },
  { type: "allowed_merchants", merchant_ids: null },
  {
    type: "product",
    brand: null,
    model: null,
    variant: null,
    condition: "new",
    gtin: null,
    skus: null,
    qty: 1,
  },
  { type: "must_have", attributes: ["wireless"] },
  { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
  { type: "budget", max: { amount: 30_000, currency: "CNY" } },
  {
    type: "execution_window",
    not_before: null,
    not_after: "2026-10-14T14:00:00+08:00",
  },
];

const mandate = {
  schema: "mandate.v1",
  mandate_id: "mdt_91c2",
  agent_id: "agt_7f3a",
  agent_key_binding: "p256:key",
  description: "Wireless headphones",
  intent_level: "open",
  user_text: "Get wireless headphones",
  user_text_source: "webank_screen",
  constraints,
  status: "active",
  spent: { amount: 0, currency: "CNY" },
  occurrences: 0,
  in_flight_payment_id: null,
  approved_by: "user_biometric",
  created_at: timestamp,
};

const paymentRequest = {
  schema: "payreq.v1",
  merchant_id: "mch_shopA",
  order_id: "ord_5521",
  amount: { amount: 27_900, currency: "CNY" },
  line_items: [
    {
      sku: "SONY-XM5-BLK",
      gtin: "4548736132597",
      name: "Sony WH-1000XM5 Black",
      condition: "new",
      qty: 1,
      unit_price: { amount: 27_900, currency: "CNY" },
    },
  ],
  expires_at: "2026-10-13T14:37:00+08:00",
  nonce: "b64nonce",
  merchant_sig: "b64sig",
};

const decision = {
  schema: "decision.v1",
  decision_id: "dec_44b0",
  payment_id: "pay_1a2b",
  outcome: "APPROVED",
  autonomy_level: "L3",
  checks: [{ name: "agent_auth", result: "pass" }],
  risk_signals: [
    { type: "price_above_evidence", score: 0, action: "authorized" },
  ],
  user_explanation: "Within the approved mandate.",
  created_at: timestamp,
};

const receipt = {
  schema: "receipt.v1",
  receipt_id: "rcp_77aa",
  payment_id: "pay_1a2b",
  decision_id: "dec_44b0",
  mandate_id: "mdt_91c2",
  merchant_id: "mch_shopA",
  merchant_legal_name: "Shop A Electronics Co., Ltd. (mock)",
  merchant_uscc: "91440300MA5XXXXXXX",
  order_id: "ord_5521",
  amount: { amount: 27_900, currency: "CNY" },
  outcome: "APPROVED",
  chain: { network: "fisco-local-20200", payment_tx: tx, audit_tx: tx },
  issued_at: timestamp,
  webank_sig: "b64sig",
};

describe("shared contract boundaries", () => {
  it("accepts canonical versioned records", () => {
    expect(MandateSchema.safeParse(mandate).success).toBe(true);
    expect(ApprovalSchema.safeParse(approval).success).toBe(true);
    expect(PaymentRequestSchema.safeParse(paymentRequest).success).toBe(true);
    expect(DecisionSchema.safeParse(decision).success).toBe(true);
    expect(ReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  it("rejects floating-point money, unsafe integers, and wrong ID prefixes", () => {
    expect(
      MoneySchema.safeParse({ amount: 279.01, currency: "CNY" }).success,
    ).toBe(false);
    expect(
      MoneySchema.safeParse({
        amount: Number.MAX_SAFE_INTEGER + 1,
        currency: "CNY",
      }).success,
    ).toBe(false);
    expect(
      MandateSchema.safeParse({ ...mandate, mandate_id: "pay_91c2" }).success,
    ).toBe(false);
  });

  it("rejects a changed merchant payload and mixed currencies", () => {
    expect(
      PaymentRequestSchema.safeParse({ ...paymentRequest, forged_field: true })
        .success,
    ).toBe(false);
    expect(
      PaymentRequestSchema.safeParse({
        ...paymentRequest,
        line_items: [
          {
            ...paymentRequest.line_items[0],
            unit_price: { amount: 27_900, currency: "USD" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires merchant and SKU locks for listing intent", () => {
    expect(
      MandateSchema.safeParse({ ...mandate, intent_level: "listing" }).success,
    ).toBe(false);
    const listing = {
      ...mandate,
      intent_level: "listing",
      constraints: constraints.map((item) => {
        if (item.type === "allowed_merchants")
          return { ...item, merchant_ids: ["mch_shopA"] };
        if (item.type === "product") return { ...item, skus: ["SONY-XM5-BLK"] };
        return item;
      }),
    };
    expect(MandateSchema.safeParse(listing).success).toBe(true);
  });

  it("requires stable product identity for product intent", () => {
    expect(
      MandateSchema.safeParse({ ...mandate, intent_level: "product" }).success,
    ).toBe(false);
    expect(
      MandateSchema.safeParse({
        ...mandate,
        intent_level: "product",
        constraints: constraints.map((item) =>
          item.type === "product" ? { ...item, gtin: "4548736132597" } : item,
        ),
      }).success,
    ).toBe(true);
  });

  it("records approval provenance without inventing consent for closed mandates", () => {
    expect(
      MandateSchema.safeParse({
        ...mandate,
        status: "pending_user",
        approved_by: null,
      }).success,
    ).toBe(true);
    expect(
      MandateSchema.safeParse({ ...mandate, status: "pending_user" }).success,
    ).toBe(false);
    expect(
      MandateSchema.safeParse({ ...mandate, approved_by: null }).success,
    ).toBe(false);
    expect(
      MandateSchema.safeParse({
        ...mandate,
        status: "exhausted",
        approved_by: null,
      }).success,
    ).toBe(false);
    expect(
      MandateSchema.safeParse({
        ...mandate,
        status: "cancelled",
        approved_by: null,
      }).success,
    ).toBe(true);
    expect(
      MandateSchema.safeParse({
        ...mandate,
        status: "expired",
        approved_by: null,
      }).success,
    ).toBe(true);
    expect(
      MandateSchema.safeParse({
        ...mandate,
        status: "cancelled",
        approved_by: "user_biometric",
      }).success,
    ).toBe(true);
    expect(
      MandateSchema.safeParse({
        ...mandate,
        approved_by: "user_biometric_matched",
      }).success,
    ).toBe(true);
    expect(
      MandateSchema.safeParse({ ...mandate, approved_by: "user_pin" }).success,
    ).toBe(false);
  });

  it("rejects duplicate constraints and invalid windows at creation", () => {
    expect(
      CreateMandateRequestSchema.safeParse({
        description: "Headphones",
        constraints: [...constraints, constraints[0]],
      }).success,
    ).toBe(false);
    expect(
      CreateMandateRequestSchema.safeParse({
        description: "Headphones",
        constraints: [
          {
            type: "execution_window",
            not_before: "2026-10-15T14:00:00+08:00",
            not_after: "2026-10-14T14:00:00+08:00",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a denial with a payment transaction", () => {
    expect(
      ReceiptSchema.safeParse({ ...receipt, outcome: "DENIED" }).success,
    ).toBe(false);
    expect(
      ReceiptSchema.safeParse({
        ...receipt,
        outcome: "DENIED",
        chain: { network: "fisco-local-20200", audit_tx: tx },
      }).success,
    ).toBe(true);
  });

  it("requires action verification only when approving", () => {
    expect(
      ApprovalDecisionRequestSchema.safeParse({ decision: "approve" }).success,
    ).toBe(false);
    expect(
      ApprovalDecisionRequestSchema.safeParse({ decision: "reject" }).success,
    ).toBe(true);
    expect(
      ApprovalDecisionRequestSchema.safeParse({
        decision: "approve",
        verification: {
          action_hash: hash,
          device_signature: "p256signature",
        },
      }).success,
    ).toBe(true);
    expect(
      ApprovalDecisionRequestSchema.safeParse({
        decision: "reject",
        verification: { action_hash: hash, device_signature: "p256signature" },
      }).success,
    ).toBe(false);
  });

  it("requires biometrics and rejects PIN fallback for all agent approvals", () => {
    expect(
      VerificationSchema.safeParse({
        action_hash: hash,
        device_signature: "p256signature",
      }).success,
    ).toBe(true);
    expect(
      VerificationSchema.safeParse({
        action_hash: hash,
        pin_proof: { challenge_id: "one", pin: "123456" },
      }).success,
    ).toBe(false);
    expect(
      VerificationSchema.safeParse({
        action_hash: hash,
        device_signature: "p256signature",
        pin_proof: { challenge_id: "one", pin: "123456" },
      }).success,
    ).toBe(false);
    expect(
      ZeroTrustVerificationSchema.safeParse({
        action_hash: hash,
        device_signature: "p256signature",
      }).success,
    ).toBe(false);
    expect(
      ZeroTrustVerificationSchema.safeParse({
        action_hash: hash,
        device_signature: "p256signature",
        request_number: "001234",
      }).success,
    ).toBe(true);
    expect(
      EverydayVerificationSchema.safeParse({
        action_hash: hash,
        device_signature: "p256signature",
      }).success,
    ).toBe(true);
    expect(
      EverydayVerificationSchema.safeParse({
        action_hash: hash,
        device_signature: "p256signature",
        request_number: "001234",
      }).success,
    ).toBe(false);
    expect(
      ZeroTrustVerificationSchema.safeParse({
        action_hash: hash,
        device_signature: "p256signature",
        request_number: 1234,
      }).success,
    ).toBe(false);
  });

  it("delivers the one-time number only in connector-facing pairing and payment responses", () => {
    const pairing = {
      device_code: "dev_123",
      user_code: "WQ7K-3MXP",
      verification_uri: "https://example.test/pair",
      qr_payload: "https://example.test/pair?code=WQ7K-3MXP",
      request_number: "001234",
      expires_in: 600,
      interval: 3,
    };
    expect(DeviceAuthorizationResponseSchema.safeParse(pairing).success).toBe(
      true,
    );
    expect(
      DeviceAuthorizationResponseSchema.safeParse({
        ...pairing,
        request_number: undefined,
      }).success,
    ).toBe(false);
    expect(
      ApprovalSchema.safeParse({ ...approval, request_number: "001234" })
        .success,
    ).toBe(false);
    expect(
      AppEventSchema.safeParse({
        event: "approval.created",
        data: { approval: { ...approval, request_number: "001234" } },
      }).success,
    ).toBe(false);

    const stepUp = { ...decision, outcome: "STEP_UP" };
    const pending = {
      payment_id: "pay_1a2b",
      status: "awaiting_user",
      decision: stepUp,
      approval_id: "apr_31cd",
      poll_after: 3,
    };
    expect(
      PaymentSubmissionResponseSchema.safeParse({
        ...pending,
        approval_level: "zero_trust",
        request_number: "001234",
      }).success,
    ).toBe(true);
    expect(
      PaymentSubmissionResponseSchema.safeParse({
        ...pending,
        approval_level: "zero_trust",
      }).success,
    ).toBe(false);
    expect(
      PaymentSubmissionResponseSchema.safeParse({
        ...pending,
        approval_level: "everyday",
      }).success,
    ).toBe(true);
    expect(
      PaymentSubmissionResponseSchema.safeParse({
        ...pending,
        approval_level: "everyday",
        request_number: "001234",
      }).success,
    ).toBe(false);
  });

  it("uses a 180 second default approval deadline", () => {
    expect(DEFAULT_APPROVAL_TTL_SECONDS).toBe(180);
    expect(approvalExpiresAt(timestamp)).toBe("2026-10-13T06:25:05.000Z");
    expect(approvalExpiresAt(timestamp, 60)).toBe("2026-10-13T06:23:05.000Z");
    expect(() => approvalExpiresAt(timestamp, 0)).toThrow();
  });

  it("keeps payment status, decision, and receipt consistent", () => {
    expect(
      PaymentSubmissionResponseSchema.safeParse({
        payment_id: "pay_1a2b",
        status: "paid",
        decision,
        receipt,
      }).success,
    ).toBe(true);
    expect(
      PaymentSubmissionResponseSchema.safeParse({
        payment_id: "pay_1a2b",
        status: "denied",
        decision,
        receipt,
      }).success,
    ).toBe(false);
    expect(
      PaymentStatusResponseSchema.safeParse({
        payment_id: "pay_1a2b",
        status: "denied",
        decision,
        receipt,
      }).success,
    ).toBe(false);
  });

  it("validates the agent handoff and typed app events", () => {
    expect(
      CreatePaymentRequestSchema.safeParse({
        mandate_id: "mdt_91c2",
        payment_request: "ecny://pay?d=eyJmb28iOiJiYXIifQ",
        price_evidence: [],
        rationale: "Cheapest verified listing",
      }).success,
    ).toBe(true);
    expect(
      AppEventSchema.safeParse({
        event: "payment.completed",
        data: {
          payment_id: "pay_1a2b",
          outcome: "APPROVED",
          amount: { amount: 27_900, currency: "CNY" },
          merchant: "Shop A",
          receipt_id: "rcp_77aa",
        },
      }).success,
    ).toBe(true);
  });

  it("round trips a signed payment request URI and validates decoded JSON", () => {
    const signed = {
      ...paymentRequest,
      line_items: [{ ...paymentRequest.line_items[0], name: "索尼耳机" }],
    };
    const uri = encodePaymentRequestUri(signed);
    expect(uri).toMatch(/^ecny:\/\/pay\?d=[A-Za-z0-9_-]+$/);
    expect(decodePaymentRequestUri(uri)).toEqual(signed);
    expect(() => decodePaymentRequestUri("ecny://pay?d=e30")).toThrow();
    expect(() => decodePaymentRequestUri("ecny://pay?d=!!!")).toThrow();
  });
});
