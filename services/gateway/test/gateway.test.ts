import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  type Agent,
  encodePaymentRequestUri,
  type Mandate,
  type PaymentRequest,
  type Policy,
} from "@webank/contracts";
import {
  createGuardianEvaluator,
  evaluateWithTransport,
} from "@webank/guardian";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../src/app.js";
import { canonicalJson } from "../src/crypto.js";
import type { GatewayDependencies, Merchant } from "../src/types.js";

const merchantKeys = generateKeyPairSync("ed25519");
const otherMerchantKeys = generateKeyPairSync("ed25519");
const receiptKeys = generateKeyPairSync("ed25519");
const merchant: Merchant = {
  merchant_id: "mch_shopA",
  name: "Shop A Electronics",
  legal_name: "Shop A Electronics Co. (mock)",
  uscc: "MOCK91440300TEST001",
  category: "electronics",
  first_seen: false,
  honeypot: false,
  public_key: `0x${merchantKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`,
};
const otherMerchant: Merchant = {
  ...merchant,
  merchant_id: "mch_shopB",
  name: "Shop B Lifestyle",
  legal_name: "Shop B Lifestyle Co. (mock)",
  uscc: "MOCK91440300TEST002",
  public_key: `0x${otherMerchantKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`,
};
const agent: Agent = {
  schema: "agent.v1",
  agent_id: "agt_test",
  user_id: "usr_test",
  display_name: "Claude Test",
  provider: "anthropic",
  public_key: "p256:test-agent-key",
  scopes: ["wallet:pay", "wallet:mandate", "wallet:history:self"],
  licence: { level: "L", points: 0, clean_purchases: 0, drills_passed: 0 },
  status: "active",
  created_at: "2026-10-14T00:00:00Z",
  last_used_at: null,
};
const policy: Policy = {
  schema: "policy.v1",
  user_id: "usr_test",
  per_payment_max: { amount: 30_000, currency: "CNY" },
  daily_max: { amount: 50_000, currency: "CNY" },
  monthly_max: { amount: 100_000, currency: "CNY" },
  auto_approve_below: { amount: 10_000, currency: "CNY" },
  blocked_categories: ["gift_cards", "crypto"],
  new_merchant_requires_tap: false,
  treasurer: {
    enabled: false,
    buffer_target: { amount: 0, currency: "CNY" },
    daily_topup_ceiling: { amount: 10_000, currency: "CNY" },
    monthly_topup_ceiling: { amount: 20_000, currency: "CNY" },
    protected_main_balance: { amount: 30_000, currency: "CNY" },
  },
};
const constraints: Mandate["constraints"] = [
  { type: "amount_range", max: { amount: 30_000, currency: "CNY" } },
  { type: "categories", allowed: ["electronics"] },
  { type: "budget", max: { amount: 30_000, currency: "CNY" } },
  { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
  {
    type: "execution_window",
    not_before: null,
    not_after: "2026-10-15T00:00:00Z",
  },
];

function signedPayreq(
  overrides: Partial<PaymentRequest> = {},
  signer = merchantKeys.privateKey,
): string {
  const unsigned = {
    schema: "payreq.v1" as const,
    merchant_id: merchant.merchant_id,
    order_id: "ord_1",
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
    expires_at: "2026-10-15T00:00:00Z",
    nonce: "unique-shop-nonce",
    ...overrides,
  };
  const { merchant_sig: _ignored, ...forSignature } =
    unsigned as PaymentRequest;
  const merchant_sig = sign(
    null,
    Buffer.from(canonicalJson(forSignature), "utf8"),
    signer,
  ).toString("base64url");
  return encodePaymentRequestUri({ ...forSignature, merchant_sig });
}

function fixture(
  options: {
    seedMandate?: Mandate;
    risk?: "pass" | "step_up" | "deny";
    guardian?: "pass" | "step_up" | "deny";
    guardianFailure?: boolean;
    guardianEvaluator?: GatewayDependencies["evaluateGuardian"];
    railFailure?: boolean;
    agent?: Agent;
    merchant?: Merchant;
    clock?: { value: Date };
    demoApprovalEnabled?: boolean;
  } = {},
) {
  const executed: string[] = [];
  const railAttempts: string[] = [];
  const anchored: string[] = [];
  const demerits: string[] = [];
  const deps: GatewayDependencies = {
    authenticateAgent: async (request) =>
      request.headers.authorization === "Bearer test-agent"
        ? (options.agent ?? agent)
        : null,
    authenticateApp: async (request) =>
      request.headers.authorization === "Bearer test-app"
        ? "usr_test"
        : request.headers.authorization === "Bearer other-app"
          ? "usr_other"
          : null,
    demoApprovalsEnabled:
      options.demoApprovalEnabled === false ? undefined : true,
    demoApprovalVerifier: async (approval, verification) => {
      const proof = verification as {
        action_hash?: string;
        device_signature?: string;
      };
      return proof.action_hash === approval.payload_hash &&
        proof.device_signature === "test-biometric-proof"
        ? "user_biometric"
        : false;
    },
    recordNumberMatchFailure: async (agentId) => {
      demerits.push(agentId);
    },
    lookupMerchant: async (id) =>
      id === merchant.merchant_id
        ? (options.merchant ?? merchant)
        : id === otherMerchant.merchant_id
          ? otherMerchant
          : null,
    reserveMandate: async () => true,
    releaseMandate: async () => {},
    assessRisk: async () => ({
      result: options.risk ?? "pass",
      signals: [],
      explanation: "Risk checks passed.",
    }),
    evaluateGuardian:
      options.guardianEvaluator ??
      (async () => {
        if (options.guardianFailure) throw new Error("Guardian unavailable");
        return {
          verdict: options.guardian ?? "pass",
          reasons: ["Fixture verdict"],
          user_explanation: "Verified purchase matches the mandate.",
        };
      }),
    executePayment: async ({ paymentId }) => {
      railAttempts.push(paymentId);
      if (options.railFailure) throw new Error("Rail unavailable");
      executed.push(paymentId);
      return `0x${"1".repeat(64)}`;
    },
    anchorAudit: async (hash) => {
      anchored.push(hash);
      return `0x${createHash("sha256").update(hash).digest("hex")}`;
    },
    signReceipt: async (bytes) =>
      sign(null, bytes, receiptKeys.privateKey).toString("base64url"),
    now: () => options.clock?.value ?? new Date("2026-10-14T12:00:00Z"),
  };
  const app = createGateway(deps, {
    agents: [options.agent ?? agent],
    policies: [policy],
    mandates: options.seedMandate ? [options.seedMandate] : [],
  });
  return { app, executed, railAttempts, anchored, demerits };
}

function activeMandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    schema: "mandate.v1",
    mandate_id: "mdt_seed",
    agent_id: agent.agent_id,
    agent_key_binding: agent.public_key,
    description: "Buy Sony headphones",
    intent_level: "open",
    user_text: "Buy Sony headphones",
    user_text_source: "webank_screen",
    constraints,
    status: "active",
    spent: { amount: 0, currency: "CNY" },
    occurrences: 0,
    in_flight_payment_id: null,
    approved_by: "user_biometric",
    created_at: "2026-10-14T00:00:00Z",
    ...overrides,
  };
}

async function payment(
  app: ReturnType<typeof createGateway>,
  mandateId: string,
  uri: string,
  key = "payment-1",
) {
  return app.inject({
    method: "POST",
    url: "/v1/agent/payments",
    headers: { authorization: "Bearer test-agent", "idempotency-key": key },
    payload: {
      mandate_id: mandateId,
      payment_request: uri,
      price_evidence: [],
      rationale: "Agent says this is a good option; this is untrusted.",
    },
  });
}

describe("Gateway HTTP decision slice", () => {
  const openApps: ReturnType<typeof createGateway>[] = [];
  afterEach(async () => {
    await Promise.all(openApps.splice(0).map((app) => app.close()));
  });

  it("requires a verified mandate approval and a second L-plate payment approval before paying", async () => {
    const { app, executed, anchored } = fixture();
    openApps.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/v1/agent/mandates",
      headers: {
        authorization: "Bearer test-agent",
        "idempotency-key": "mandate-1",
      },
      payload: {
        description: "Buy Sony headphones under 300 CNY",
        constraints,
      },
    });
    expect(created.statusCode).toBe(202);
    const mandateId = created.json().mandate.mandate_id as string;
    expect(created.json().mandate.user_text_source).toBe("agent_reported");
    expect(created.json().mandate.approved_by).toBeNull();
    const beforeApproval = await payment(app, mandateId, signedPayreq());
    expect(beforeApproval.statusCode).toBe(403);
    expect(executed).toHaveLength(0);

    const cards = await app.inject({
      method: "GET",
      url: "/v1/app/approvals",
      headers: { authorization: "Bearer test-app" },
    });
    const mandateCard = cards.json().items[0];
    const approvedMandate = await app.inject({
      method: "POST",
      url: `/v1/app/approvals/${mandateCard.approval_id}/decide`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "approve-mandate",
      },
      payload: {
        decision: "approve",
        verification: {
          action_hash: mandateCard.payload_hash,
          device_signature: "test-biometric-proof",
        },
      },
    });
    expect(approvedMandate.statusCode).toBe(200);
    expect(approvedMandate.json().mandate.user_text_source).toBe(
      "webank_screen",
    );

    const approvedUri = signedPayreq({ nonce: "post-approved-nonce" });
    const submitted = await payment(
      app,
      mandateId,
      approvedUri,
      "payment-after-approval",
    );
    expect(submitted.statusCode).toBe(202);
    expect(submitted.json().decision.outcome).toBe("STEP_UP");
    expect(
      submitted
        .json()
        .decision.checks.map((check: { name: string }) => check.name),
    ).toEqual([
      "agent_auth",
      "rail_validation",
      "mandate",
      "policy_licence",
      "risk",
      "guardian",
    ]);
    expect(submitted.json().approval_level).toBe("zero_trust");
    expect(submitted.json().request_number).toMatch(/^\d{6}$/);
    expect(executed).toHaveLength(0);
    const paymentCard = (
      await app.inject({
        method: "GET",
        url: "/v1/app/approvals",
        headers: { authorization: "Bearer test-app" },
      })
    ).json().items[1];
    expect(paymentCard.lines.join(" ")).toContain(merchant.uscc);
    const approvedPayment = await app.inject({
      method: "POST",
      url: `/v1/app/approvals/${paymentCard.approval_id}/decide`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "approve-payment",
      },
      payload: {
        decision: "approve",
        verification: {
          action_hash: paymentCard.payload_hash,
          device_signature: "test-biometric-proof",
          request_number: submitted.json().request_number,
        },
      },
    });
    expect(approvedPayment.statusCode).toBe(200);
    expect(approvedPayment.json().payment.status).toBe("paid");
    expect(executed).toHaveLength(1);
    const receipt = approvedPayment.json().payment.receipt;
    const { webank_sig, ...unsignedReceipt } = receipt;
    expect(
      verify(
        null,
        Buffer.from(canonicalJson(unsignedReceipt)),
        receiptKeys.publicKey,
        Buffer.from(webank_sig, "base64url"),
      ),
    ).toBe(true);
    expect(anchored.length).toBeGreaterThanOrEqual(3);
    const retry = await payment(
      app,
      mandateId,
      approvedUri,
      "payment-after-approval",
    );
    expect(retry.statusCode).toBe(202);
    expect(retry.json().payment_id).toBe(submitted.json().payment_id);
    expect(executed).toHaveLength(1);
    const history = await app.inject({
      method: "GET",
      url: "/v1/app/payments",
      headers: { authorization: "Bearer test-app" },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().items).toContainEqual(
      expect.objectContaining({
        payment_id: submitted.json().payment_id,
        status: "paid",
      }),
    );
    expect(history.json().items).toContainEqual(
      expect.objectContaining({ status: "denied" }),
    );
    const detail = await app.inject({
      method: "GET",
      url: `/v1/app/payments/${submitted.json().payment_id}`,
      headers: { authorization: "Bearer test-app" },
    });
    expect(detail.json().receipt.receipt_id).toBe(receipt.receipt_id);
    const pending = await app.inject({
      method: "GET",
      url: "/v1/app/approvals?status=pending",
      headers: { authorization: "Bearer test-app" },
    });
    expect(pending.json().items).toEqual([]);
    const events = await app.inject({
      method: "GET",
      url: "/v1/app/events?after=0",
      headers: { authorization: "Bearer test-app" },
    });
    expect(
      events.json().events.map((item: { type: string }) => item.type),
    ).toContain("payment.completed");
    const createdCardEvent = events
      .json()
      .events.find(
        (item: { type: string }) => item.type === "approval.created",
      );
    expect(createdCardEvent.data.approval.status).toBe("pending");
    const cursor = events.json().next_cursor as string;
    const noNewEvents = await app.inject({
      method: "GET",
      url: `/v1/app/events?after=${cursor}`,
      headers: { authorization: "Bearer test-app" },
    });
    expect(noNewEvents.json().events).toEqual([]);
    const otherHistory = await app.inject({
      method: "GET",
      url: "/v1/app/payments",
      headers: { authorization: "Bearer other-app" },
    });
    expect(otherHistory.json().items).toEqual([]);
    const otherApprovals = await app.inject({
      method: "GET",
      url: "/v1/app/approvals",
      headers: { authorization: "Bearer other-app" },
    });
    expect(otherApprovals.json().items).toEqual([]);
    const otherAgents = await app.inject({
      method: "GET",
      url: "/v1/app/agents",
      headers: { authorization: "Bearer other-app" },
    });
    expect(otherAgents.json().items).toEqual([]);
    const otherEvents = await app.inject({
      method: "GET",
      url: "/v1/app/events?after=0",
      headers: { authorization: "Bearer other-app" },
    });
    expect(otherEvents.json().events).toEqual([]);
    const otherDetail = await app.inject({
      method: "GET",
      url: `/v1/app/payments/${submitted.json().payment_id}`,
      headers: { authorization: "Bearer other-app" },
    });
    expect(otherDetail.statusCode).toBe(403);
  });

  it("disables demo approvals without explicit opt-in while allowing user rejection", async () => {
    const { app } = fixture({ demoApprovalEnabled: false });
    openApps.push(app);
    const created = await app.inject({
      method: "POST",
      url: "/v1/agent/mandates",
      headers: {
        authorization: "Bearer test-agent",
        "idempotency-key": "demo-disabled-create",
      },
      payload: { description: "Buy Sony headphones", constraints },
    });
    expect(created.statusCode).toBe(202);
    const card = (
      await app.inject({
        method: "GET",
        url: "/v1/app/approvals?status=pending",
        headers: { authorization: "Bearer test-app" },
      })
    ).json().items[0];
    const blocked = await app.inject({
      method: "POST",
      url: `/v1/app/approvals/${card.approval_id}/decide`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "demo-disabled-approve",
      },
      payload: {
        decision: "approve",
        verification: {
          action_hash: card.payload_hash,
          device_signature: "test-biometric-proof",
        },
      },
    });
    expect(blocked.statusCode).toBe(503);
    const rejected = await app.inject({
      method: "POST",
      url: `/v1/app/approvals/${card.approval_id}/decide`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "demo-disabled-reject",
      },
      payload: { decision: "reject" },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().approval.status).toBe("rejected");
  });

  it("refuses demo proof mode in a production process", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => fixture()).toThrow(/forbidden in production/);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("denies a signed item that violates a locked product and still signs an anchored denial receipt", async () => {
    const locked = activeMandate({
      intent_level: "product",
      constraints: [
        ...constraints,
        {
          type: "product",
          brand: "Sony",
          model: "WH-1000XM5",
          variant: null,
          condition: "new",
          gtin: "4548736132597",
          skus: null,
          qty: 1,
        },
      ],
    });
    const { app, executed } = fixture({ seedMandate: locked });
    openApps.push(app);
    const response = await payment(
      app,
      locked.mandate_id,
      signedPayreq({
        line_items: [
          {
            sku: "CASE-ONLY",
            gtin: "0000000000000",
            name: "Case only",
            condition: "new",
            qty: 1,
            unit_price: { amount: 27_900, currency: "CNY" },
          },
        ],
      }),
    );
    expect(response.statusCode).toBe(403);
    expect(
      response
        .json()
        .decision.checks.find(
          (check: { name: string }) => check.name === "mandate",
        ).detail.reason,
    ).toBe("gtin_mismatch");
    expect(response.json().receipt.chain.audit_tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(response.json().receipt.chain.payment_tx).toBeUndefined();
    expect(executed).toHaveLength(0);
    const deniedHistory = await app.inject({
      method: "GET",
      url: "/v1/app/payments",
      headers: { authorization: "Bearer test-app" },
    });
    expect(deniedHistory.json().items[0].status).toBe("denied");
    const deniedDetail = await app.inject({
      method: "GET",
      url: `/v1/app/payments/${response.json().payment_id}`,
      headers: { authorization: "Bearer test-app" },
    });
    expect(deniedDetail.json().receipt.outcome).toBe("DENIED");
    const deniedEvents = await app.inject({
      method: "GET",
      url: "/v1/app/events",
      headers: { authorization: "Bearer test-app" },
    });
    expect(
      deniedEvents.json().events.map((item: { type: string }) => item.type),
    ).toContain("payment.denied");
  });

  it("rejects a forged merchant signature and anchors the rejected attempt", async () => {
    const { app, executed, anchored } = fixture({
      seedMandate: activeMandate(),
    });
    openApps.push(app);
    const forged = signedPayreq();
    const uri = encodePaymentRequestUri({
      ...decodeUri(forged),
      merchant_sig: Buffer.alloc(64).toString("base64url"),
    });
    const response = await payment(app, "mdt_seed", uri);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("payreq_invalid");
    expect(anchored).toHaveLength(1);
    expect(executed).toHaveLength(0);
  });

  it("rejects reuse of a signed merchant nonce under a different idempotency key", async () => {
    const { app, executed } = fixture({ seedMandate: activeMandate() });
    openApps.push(app);
    const uri = signedPayreq();
    const first = await payment(app, "mdt_seed", uri, "first-attempt");
    expect(first.statusCode).toBe(202);
    const reused = await payment(app, "mdt_seed", uri, "new-attempt");
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe("mandate_in_flight");
    const card = (
      await app.inject({
        method: "GET",
        url: "/v1/app/approvals",
        headers: { authorization: "Bearer test-app" },
      })
    ).json().items[0];
    await app.inject({
      method: "POST",
      url: `/v1/app/approvals/${card.approval_id}/decide`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "reject",
      },
      payload: { decision: "reject" },
    });
    const replay = await payment(app, "mdt_seed", uri, "replay-after-reject");
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error.code).toBe("payreq_invalid");
    expect(executed).toHaveLength(0);
  });

  it("rejects a changed signed amount and a genuine bill from a different locked payee", async () => {
    const locked = activeMandate({
      intent_level: "listing",
      constraints: [
        ...constraints,
        { type: "allowed_merchants", merchant_ids: [merchant.merchant_id] },
        {
          type: "product",
          brand: null,
          model: null,
          variant: null,
          condition: "new",
          gtin: null,
          skus: ["SONY-XM5-BLK"],
          qty: 1,
        },
      ],
    });
    const { app, executed } = fixture({ seedMandate: locked });
    openApps.push(app);
    const signed = decodeUri(signedPayreq());
    const changed = encodePaymentRequestUri({
      ...signed,
      amount: { amount: 25_000, currency: "CNY" },
    });
    const tampered = await payment(
      app,
      locked.mandate_id,
      changed,
      "tampered-amount",
    );
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json().error.code).toBe("payreq_invalid");
    const otherShopBill = signedPayreq(
      { merchant_id: otherMerchant.merchant_id, order_id: "ord_other" },
      otherMerchantKeys.privateKey,
    );
    const swapped = await payment(
      app,
      locked.mandate_id,
      otherShopBill,
      "swapped-payee",
    );
    expect(swapped.statusCode).toBe(403);
    expect(
      swapped
        .json()
        .decision.checks.find(
          (check: { name: string }) => check.name === "mandate",
        ).detail.reason,
    ).toBe("merchant_outside_mandate");
    expect(executed).toHaveLength(0);
  });

  it("keeps a deterministic step-up even when the Guardian says pass, and rejects a changed idempotency body", async () => {
    const probation = {
      ...agent,
      licence: { ...agent.licence, level: "P" as const },
    };
    const { app, executed } = fixture({
      agent: probation,
      seedMandate: activeMandate(),
      risk: "step_up",
      guardian: "pass",
    });
    openApps.push(app);
    const first = await payment(app, "mdt_seed", signedPayreq());
    expect(first.statusCode).toBe(202);
    expect(first.json().decision.outcome).toBe("STEP_UP");
    const conflicting = await payment(
      app,
      "mdt_seed",
      signedPayreq({ order_id: "ord_other" }),
    );
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().error.code).toBe("idempotency_conflict");
    expect(executed).toHaveLength(0);
  });

  it("cancels a first-payment request after three wrong numbers without paying", async () => {
    const { app, executed, demerits } = fixture({
      seedMandate: activeMandate(),
    });
    openApps.push(app);
    const submitted = await payment(app, "mdt_seed", signedPayreq());
    expect(submitted.statusCode).toBe(202);
    const card = (
      await app.inject({
        method: "GET",
        url: "/v1/app/approvals",
        headers: { authorization: "Bearer test-app" },
      })
    ).json().items[0];
    expect(card.request_number).toBeUndefined();
    const wrongNumber =
      submitted.json().request_number === "000000" ? "000001" : "000000";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const wrong = await app.inject({
        method: "POST",
        url: `/v1/app/approvals/${card.approval_id}/decide`,
        headers: {
          authorization: "Bearer test-app",
          "idempotency-key": `wrong-${attempt}`,
        },
        payload: {
          decision: "approve",
          verification: {
            action_hash: card.payload_hash,
            device_signature: "test-biometric-proof",
            request_number: wrongNumber,
          },
        },
      });
      expect(wrong.statusCode).toBe(401);
    }
    const status = await app.inject({
      method: "GET",
      url: `/v1/app/payments/${submitted.json().payment_id}`,
      headers: { authorization: "Bearer test-app" },
    });
    expect(status.json().status).toBe("denied");
    expect(executed).toHaveLength(0);
    expect(demerits).toEqual([agent.agent_id]);
  });

  it("expires a pending step-up and freezes the agent immediately", async () => {
    const clock = { value: new Date("2026-10-14T12:00:00Z") };
    const { app, executed } = fixture({ seedMandate: activeMandate(), clock });
    openApps.push(app);
    const submitted = await payment(app, "mdt_seed", signedPayreq());
    expect(submitted.statusCode).toBe(202);
    clock.value = new Date("2026-10-14T12:03:01Z");
    const status = await app.inject({
      method: "GET",
      url: `/v1/app/payments/${submitted.json().payment_id}`,
      headers: { authorization: "Bearer test-app" },
    });
    expect(status.json().status).toBe("denied");
    const frozen = await app.inject({
      method: "POST",
      url: `/v1/app/agents/${agent.agent_id}/freeze`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "freeze",
      },
    });
    expect(frozen.statusCode).toBe(200);
    const next = await payment(
      app,
      "mdt_seed",
      signedPayreq({ order_id: "ord_2" }),
      "payment-2",
    );
    expect(next.statusCode).toBe(401);
    expect(next.json().error.code).toBe("agent_frozen");
    expect(executed).toHaveLength(0);
  });

  it("escalates when the Guardian is unavailable even if deterministic checks pass", async () => {
    const experienced = {
      ...agent,
      licence: { ...agent.licence, level: "P" as const, clean_purchases: 1 },
    };
    const { app, executed } = fixture({
      agent: experienced,
      seedMandate: activeMandate(),
      guardianFailure: true,
    });
    openApps.push(app);
    const smallAmount = { amount: 5_000, currency: "CNY" };
    const response = await payment(
      app,
      "mdt_seed",
      signedPayreq({
        amount: smallAmount,
        line_items: [
          {
            sku: "SONY-XM5-BLK",
            gtin: "4548736132597",
            name: "Sony WH-1000XM5 Black",
            condition: "new",
            qty: 1,
            unit_price: smallAmount,
          },
        ],
      }),
    );
    expect(response.statusCode).toBe(202);
    expect(response.json().approval_level).toBe("everyday");
    expect(response.json().request_number).toBeUndefined();
    expect(
      response
        .json()
        .decision.checks.find(
          (check: { name: string }) => check.name === "guardian",
        ).detail.reason,
    ).toBe("guardian_unavailable");
    expect(executed).toHaveLength(0);
  });

  it("keeps actual Guardian no-key, refusal, and timeout responses at STEP_UP", async () => {
    const experienced: Agent = {
      ...agent,
      licence: { ...agent.licence, level: "FULL", clean_purchases: 1 },
    };
    const evaluators: GatewayDependencies["evaluateGuardian"][] = [
      createGuardianEvaluator({ apiKey: "" }),
      (input) =>
        evaluateWithTransport(input, async () => ({
          stop_reason: "refusal",
          parsed_output: null,
        })),
      (input) =>
        evaluateWithTransport(input, async () => new Promise(() => {}), 2),
    ];
    for (const evaluator of evaluators) {
      const { app, executed } = fixture({
        agent: experienced,
        seedMandate: activeMandate(),
        guardianEvaluator: evaluator,
      });
      openApps.push(app);
      const response = await payment(app, "mdt_seed", signedPayreq());
      expect(response.statusCode).toBe(202);
      expect(response.json().decision.outcome).toBe("STEP_UP");
      expect(
        response
          .json()
          .decision.checks.find(
            (check: { name: string }) => check.name === "guardian",
          ).result,
      ).toBe("step_up");
      expect(executed).toHaveLength(0);
    }
  });

  it("blocks a registered fire-drill honeypot before Guardian or rail execution", async () => {
    let guardianCalls = 0;
    const { app, executed, anchored } = fixture({
      seedMandate: activeMandate(),
      merchant: { ...merchant, honeypot: true },
      guardianEvaluator: async () => {
        guardianCalls++;
        return {
          verdict: "pass",
          reasons: ["fixture"],
          user_explanation: "fixture",
        };
      },
    });
    openApps.push(app);
    const response = await payment(app, "mdt_seed", signedPayreq());
    expect(response.statusCode).toBe(403);
    const checks = response.json().decision.checks as Array<{
      name: string;
      result: string;
      detail?: { reason?: string };
    }>;
    expect(
      checks.find((check) => check.name === "rail_validation")?.detail?.reason,
    ).toBe("fire_drill_decoy");
    expect(checks.find((check) => check.name === "guardian")?.result).toBe(
      "skipped",
    );
    expect(response.json().decision.outcome).toBe("DENIED");
    expect(response.json().receipt.chain.audit_tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(guardianCalls).toBe(0);
    expect(executed).toHaveLength(0);
    expect(anchored).toHaveLength(1);
  });

  it("denies an amount above the standing policy even under a larger valid mandate", async () => {
    const larger = activeMandate({
      constraints: constraints.map((item) => {
        if (item.type === "amount_range" || item.type === "budget")
          return { ...item, max: { amount: 40_000, currency: "CNY" } };
        return item;
      }),
    });
    const { app, executed } = fixture({ seedMandate: larger });
    openApps.push(app);
    const amount = { amount: 31_000, currency: "CNY" };
    const response = await payment(
      app,
      "mdt_seed",
      signedPayreq({
        amount,
        line_items: [
          {
            sku: "SONY-XM5-BLK",
            gtin: "4548736132597",
            name: "Sony WH-1000XM5 Black",
            condition: "new",
            qty: 1,
            unit_price: amount,
          },
        ],
      }),
    );
    expect(response.statusCode).toBe(403);
    expect(
      response
        .json()
        .decision.checks.find(
          (check: { name: string }) => check.name === "mandate",
        ).result,
    ).toBe("pass");
    expect(
      response
        .json()
        .decision.checks.find(
          (check: { name: string }) => check.name === "policy_licence",
        ).detail.reason,
    ).toBe("per_payment_cap_exceeded");
    expect(executed).toHaveLength(0);
  });

  it("fails closed and locks the mandate for reconciliation when rail execution is uncertain", async () => {
    const experienced = {
      ...agent,
      licence: { ...agent.licence, level: "P" as const, clean_purchases: 1 },
    };
    const { app, executed, railAttempts } = fixture({
      agent: experienced,
      seedMandate: activeMandate(),
      railFailure: true,
    });
    openApps.push(app);
    const amount = { amount: 5_000, currency: "CNY" };
    const uri = signedPayreq({
      amount,
      line_items: [
        {
          sku: "SONY-XM5-BLK",
          gtin: "4548736132597",
          name: "Sony WH-1000XM5 Black",
          condition: "new",
          qty: 1,
          unit_price: amount,
        },
      ],
    });
    const first = await payment(app, "mdt_seed", uri, "rail-failure");
    expect(first.statusCode).toBe(503);
    const sameRetry = await payment(app, "mdt_seed", uri, "rail-failure");
    expect(sameRetry.statusCode).toBe(503);
    const differentKey = await payment(
      app,
      "mdt_seed",
      uri,
      "rail-failure-new-key",
    );
    expect(differentKey.statusCode).toBe(409);
    expect(railAttempts).toHaveLength(1);
    expect(executed).toHaveLength(0);
  });
});

function decodeUri(uri: string): PaymentRequest {
  const payload = uri.slice("ecny://pay?d=".length);
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as PaymentRequest;
}
