import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  demoVariantBySku,
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
import {
  newAgentKey,
  signAgentRequest,
} from "../../../agents/connector-mcp/src/signing.js";
import { AgentAuth } from "../src/agent-auth.js";
import { createGateway } from "../src/app.js";
import { canonicalJson } from "../src/crypto.js";
import type {
  GatewayDependencies,
  Merchant,
  WalletFundingRail,
} from "../src/types.js";

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
  payout: `0x${"4".repeat(40)}`,
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
  const normalized = {
    ...unsigned,
    line_items: [
      ...unsigned.line_items.map((item) =>
        item.type === "shipping"
          ? item
          : {
              type: "product" as const,
              variant: item.options?.colour ?? "Black",
              options: item.options ?? { colour: "Black", size: "One size" },
              ...item,
            },
      ),
      ...(unsigned.line_items.some((item) => item.type === "shipping")
        ? []
        : [
            {
              type: "shipping" as const,
              name: "Shipping",
              qty: 1 as const,
              unit_price: { amount: 0, currency: "CNY" },
            },
          ]),
    ],
  };
  const { merchant_sig: _ignored, ...forSignature } =
    normalized as PaymentRequest;
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
    seedMandates?: Mandate[];
    signedAgents?: Agent[];
    risk?: "pass" | "step_up" | "deny";
    guardian?: "pass" | "step_up" | "deny";
    guardianFailure?: boolean;
    guardianEvaluator?: GatewayDependencies["evaluateGuardian"];
    railFailure?: boolean;
    agent?: Agent;
    merchant?: Merchant;
    clock?: { value: Date };
    demoApprovalEnabled?: boolean;
    riskDelayMs?: number;
    statePath?: string;
    releaseMandate?: GatewayDependencies["releaseMandate"];
  } = {},
) {
  const executed: string[] = [];
  const railAttempts: string[] = [];
  const anchored: string[] = [];
  const demerits: string[] = [];
  const signedVerifier = new AgentAuth();
  const signedAgentMap = new Map(
    options.signedAgents?.map((item) => [item.agent_id, item]) ?? [],
  );
  const deps: GatewayDependencies = {
    authenticateAgent: async (request) => {
      if (options.signedAgents) {
        const result = signedVerifier.verify(
          request,
          Buffer.from(JSON.stringify(request.body ?? "")),
          signedAgentMap,
          (options.clock?.value ?? new Date("2026-10-14T12:00:00Z")).getTime(),
          true,
        );
        return "agent" in result ? result.agent : null;
      }
      return request.headers.authorization === "Bearer test-agent"
        ? (options.agent ?? agent)
        : null;
    },
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
    lookupVariant: async (sku) => {
      if (sku === "SONY-XM5-BLK")
        return {
          sku,
          gtin: "4548736132597",
          merchant_id: merchant.merchant_id,
          variant: "Black",
          options: { colour: "Black", size: "One size" },
        };
      if (sku === "SONY-XM5-STN")
        return {
          sku,
          gtin: "4548736132598",
          merchant_id: merchant.merchant_id,
          variant: "Stone",
          options: { colour: "Stone", size: "One size" },
        };
      if (sku === "CASE-ONLY")
        return {
          sku,
          gtin: "0000000000000",
          merchant_id: merchant.merchant_id,
          variant: "Black",
          options: { colour: "Black", size: "One size" },
        };
      return demoVariantBySku(sku) ?? null;
    },
    reserveMandate: async () => true,
    releaseMandate: options.releaseMandate ?? (async () => {}),
    assessRisk: async () => {
      if (options.riskDelayMs)
        await new Promise((resolve) =>
          setTimeout(resolve, options.riskDelayMs),
        );
      return {
        result: options.risk ?? "pass",
        signals: [],
        explanation: "Risk checks passed.",
      };
    },
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
    statePath: options.statePath,
  };
  const app = createGateway(deps, {
    agents: options.signedAgents ?? [options.agent ?? agent],
    policies: [policy],
    mandates:
      options.seedMandates ??
      (options.seedMandate ? [options.seedMandate] : []),
  });
  return { app, deps, executed, railAttempts, anchored, demerits };
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
  const temporaryDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(openApps.splice(0).map((app) => app.close()));
    for (const directory of temporaryDirs.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  async function humanScanFixture(
    options: {
      evidenceFailsOnce?: boolean;
      broadcastLostHash?: boolean;
      clock?: { value: Date };
      statePath?: string;
    } = {},
  ) {
    const original = fixture({
      seedMandate: activeMandate(),
      clock: options.clock,
      statePath: options.statePath,
    });
    await original.app.close();
    let mainBalance = 100_000n;
    const walletBalance = 50_000n;
    let payCalls = 0;
    let noticeCalls = 0;
    let evidenceFailsOnce = options.evidenceFailsOnce ?? false;
    const tx = `0x${"8".repeat(64)}` as const;
    const rail: WalletFundingRail = {
      deployment: {
        token: `0x${"3".repeat(40)}`,
        main: `0x${"1".repeat(40)}`,
        wallet: `0x${"2".repeat(40)}`,
      },
      snapshot: async () => ({
        mainBalance,
        walletBalance,
        walletFrozen: false,
        blockNumber: 42n,
        observedAt: new Date().toISOString(),
      }),
      payFromMain: async (_confirmationId, amount) => {
        payCalls++;
        mainBalance -= amount;
        if (options.broadcastLostHash)
          throw new Error("Bank child lost stdout after broadcast");
        return tx;
      },
      mainPaymentEvidence: async (hash, payout, amount) => {
        if (evidenceFailsOnce) {
          evidenceFailsOnce = false;
          throw new Error("Receipt delayed");
        }
        expect(hash).toBe(tx);
        expect(payout).toBe(merchant.payout);
        expect(amount).toBe(27_900n);
        return { hash, blockNumber: 43n };
      },
      fund: async () => {
        throw new Error("not used");
      },
      fundingApplied: async () => false,
      fundingEvidence: async () => {
        throw new Error("not used");
      },
      findFundingEvidence: async () => undefined,
      sweep: async () => {
        throw new Error("not used");
      },
      sweepEvidence: async () => {
        throw new Error("not used");
      },
      findSweepEvidence: async () => undefined,
    };
    const deps: GatewayDependencies = {
      ...original.deps,
      walletFunding: rail,
      verifyHumanPaymentProof: async (actionHash, verification) => {
        const proof = verification as {
          action_hash?: string;
          device_signature?: string;
        };
        return (
          proof.action_hash === actionHash &&
          proof.device_signature === "simulated-local-human-payment"
        );
      },
      notifyMerchantPayment: async ({ orderId, paymentTx }) => {
        expect(orderId).toBe("ord_1");
        expect(paymentTx).toBe(tx);
        noticeCalls++;
      },
    };
    const app = createGateway(deps, {
      agents: [agent],
      policies: [policy],
      mandates: [activeMandate()],
    });
    openApps.push(app);
    return {
      app,
      payCalls: () => payCalls,
      noticeCalls: () => noticeCalls,
      balances: () => ({ mainBalance, walletBalance }),
      agentPayCalls: () => original.railAttempts.length,
      deps,
    };
  }

  it("scans only a pending local pairing QR and rejects unknown or unsigned content without paying", async () => {
    const { app, payCalls } = await humanScanFixture();
    const scan = (payload: string, authorization = "Bearer test-app") =>
      app.inject({
        method: "POST",
        url: "/v1/app/scan/decode",
        headers: { authorization },
        payload: { qr_payload: payload },
      });
    expect((await scan("https://example.com/unknown")).statusCode).toBe(400);
    const unsigned = signedPayreq({}, otherMerchantKeys.privateKey);
    expect((await scan(unsigned)).statusCode).toBe(400);
    expect((await scan(signedPayreq(), "Bearer test-agent")).statusCode).toBe(
      401,
    );
    const pair = await app.inject({
      method: "POST",
      url: "/v1/oauth/device_authorization",
      payload: {
        client_name: "QR test",
        provider: "anthropic",
        agent_public_key: newAgentKey().publicKey,
        requested_scopes: ["wallet:pay"],
      },
    });
    expect(pair.statusCode).toBe(200);
    const decoded = await scan(pair.json().qr_payload);
    expect(decoded.json()).toEqual({
      kind: "pairing",
      user_code: pair.json().user_code,
    });
    expect(payCalls()).toBe(0);
    const stillPending = await app.inject({
      method: "GET",
      url: `/v1/app/pairing/${pair.json().user_code}`,
      headers: { authorization: "Bearer test-app" },
    });
    expect(stillPending.json().pairing.status).toBe("pending");
  });

  it("reviews a signed QR then pays exactly once from main, even after two scans", async () => {
    const { app, payCalls, noticeCalls, balances } = await humanScanFixture();
    const uri = signedPayreq();
    const scan = () =>
      app.inject({
        method: "POST",
        url: "/v1/app/scan/decode",
        headers: { authorization: "Bearer test-app" },
        payload: { qr_payload: uri },
      });
    const first = (await scan()).json();
    const second = (await scan()).json();
    expect(first).toMatchObject({
      kind: "payment",
      merchant_legal_name: merchant.legal_name,
      merchant_uscc: merchant.uscc,
      amount: { amount: 27_900, currency: "CNY" },
      source_account: "main",
    });
    expect(payCalls()).toBe(0);
    const confirm = (review: typeof first, key: string, signature: string) =>
      app.inject({
        method: "POST",
        url: `/v1/app/scan/payments/${review.confirmation_id}/confirm`,
        headers: {
          authorization: "Bearer test-app",
          "idempotency-key": key,
        },
        payload: {
          challenge_id: review.challenge_id,
          verification: {
            action_hash: review.action_hash,
            device_signature: signature,
          },
        },
      });
    expect((await confirm(first, "wrong-proof", "bad")).statusCode).toBe(401);
    expect(payCalls()).toBe(0);
    const settled = await confirm(
      first,
      "human-1",
      "simulated-local-human-payment",
    );
    expect(settled.statusCode).toBe(200);
    expect(settled.json().status).toBe("completed");
    expect(settled.json().source_account).toBe("main");
    expect(balances()).toEqual({
      mainBalance: 72_100n,
      walletBalance: 50_000n,
    });
    expect(payCalls()).toBe(1);
    expect(noticeCalls()).toBe(1);
    expect(
      (await confirm(first, "human-1", "simulated-local-human-payment"))
        .statusCode,
    ).toBe(200);
    expect(
      (await confirm(second, "human-2", "simulated-local-human-payment"))
        .statusCode,
    ).toBe(409);
    expect((await scan()).statusCode).toBe(400);
    expect(payCalls()).toBe(1);
    const agentAttempt = await payment(
      app,
      "mdt_seed",
      signedPayreq({ nonce: "new-nonce-same-order" }),
      "agent-after-human",
    );
    expect(agentAttempt.statusCode).toBe(403);
    expect(agentAttempt.json().error.rule).toBe("duplicate_payment");
    expect(payCalls()).toBe(1);
  });

  it("rejects human confirmation when an agent payment for the same order is pending", async () => {
    const { app, payCalls, agentPayCalls } = await humanScanFixture();
    const review = (
      await app.inject({
        method: "POST",
        url: "/v1/app/scan/decode",
        headers: { authorization: "Bearer test-app" },
        payload: { qr_payload: signedPayreq() },
      })
    ).json();
    const pending = await payment(
      app,
      "mdt_seed",
      signedPayreq({ nonce: "agent-nonce-same-order" }),
      "agent-first",
    );
    expect(pending.statusCode).toBe(202);
    const confirm = await app.inject({
      method: "POST",
      url: `/v1/app/scan/payments/${review.confirmation_id}/confirm`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "human-after-agent",
      },
      payload: {
        challenge_id: review.challenge_id,
        verification: {
          action_hash: review.action_hash,
          device_signature: "simulated-local-human-payment",
        },
      },
    });
    expect(confirm.statusCode).toBe(409);
    expect(payCalls()).toBe(0);
    expect(agentPayCalls()).toBe(0);
  });

  it("caps the human review at the signed merchant expiry", async () => {
    const clock = { value: new Date("2026-10-14T12:00:00Z") };
    const { app, payCalls } = await humanScanFixture({ clock });
    const review = (
      await app.inject({
        method: "POST",
        url: "/v1/app/scan/decode",
        headers: { authorization: "Bearer test-app" },
        payload: {
          qr_payload: signedPayreq({
            expires_at: "2026-10-14T12:00:01Z",
          }),
        },
      })
    ).json();
    expect(review.expires_at).toBe("2026-10-14T12:00:01.000Z");
    clock.value = new Date("2026-10-14T12:00:01Z");
    const confirm = await app.inject({
      method: "POST",
      url: `/v1/app/scan/payments/${review.confirmation_id}/confirm`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "merchant-expired",
      },
      payload: {
        challenge_id: review.challenge_id,
        verification: {
          action_hash: review.action_hash,
          device_signature: "simulated-local-human-payment",
        },
      },
    });
    expect(confirm.statusCode).toBe(409);
    expect(payCalls()).toBe(0);
  });

  it("reconciles a delayed transfer receipt without submitting main payment again", async () => {
    const { app, payCalls, noticeCalls } = await humanScanFixture({
      evidenceFailsOnce: true,
    });
    const review = (
      await app.inject({
        method: "POST",
        url: "/v1/app/scan/decode",
        headers: { authorization: "Bearer test-app" },
        payload: { qr_payload: signedPayreq() },
      })
    ).json();
    const confirm = () =>
      app.inject({
        method: "POST",
        url: `/v1/app/scan/payments/${review.confirmation_id}/confirm`,
        headers: {
          authorization: "Bearer test-app",
          "idempotency-key": "human-reconcile",
        },
        payload: {
          challenge_id: review.challenge_id,
          verification: {
            action_hash: review.action_hash,
            device_signature: "simulated-local-human-payment",
          },
        },
      });
    expect((await confirm()).statusCode).toBe(503);
    expect(payCalls()).toBe(1);
    const retried = await confirm();
    expect(retried.statusCode).toBe(200);
    expect(retried.json().status).toBe("completed");
    expect(payCalls()).toBe(1);
    expect(noticeCalls()).toBe(1);
  });

  it("holds a broadcast with lost bank stdout after restart for operator evidence, without retry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-human-lost-hash-"));
    temporaryDirs.push(directory);
    const statePath = join(directory, "gateway.json");
    const { app, deps, payCalls } = await humanScanFixture({
      statePath,
      broadcastLostHash: true,
    });
    const review = (
      await app.inject({
        method: "POST",
        url: "/v1/app/scan/decode",
        headers: { authorization: "Bearer test-app" },
        payload: { qr_payload: signedPayreq() },
      })
    ).json();
    const request = {
      method: "POST" as const,
      url: `/v1/app/scan/payments/${review.confirmation_id}/confirm`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "human-lost-hash",
      },
      payload: {
        challenge_id: review.challenge_id,
        verification: {
          action_hash: review.action_hash,
          device_signature: "simulated-local-human-payment",
        },
      },
    };
    expect((await app.inject(request)).statusCode).toBe(503);
    expect(payCalls()).toBe(1);
    const envelope = JSON.parse(readFileSync(statePath, "utf8"));
    const intent = envelope.payload.humanPaymentRecords.find(
      (item: { confirmationId: string }) =>
        item.confirmationId === review.confirmation_id,
    );
    expect(intent).toMatchObject({
      status: "reconciliation_required",
      startingBlock: "42",
      merchantId: merchant.merchant_id,
      orderId: "ord_1",
      amount: 27_900,
    });
    expect(intent.paymentRequestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(intent.txHash).toBeUndefined();
    await app.close();
    openApps.splice(openApps.indexOf(app), 1);
    const restarted = createGateway(deps, {
      agents: [agent],
      policies: [policy],
      mandates: [activeMandate()],
    });
    openApps.push(restarted);
    const held = await restarted.inject({
      method: "GET",
      url: `/v1/app/scan/payments/${review.confirmation_id}`,
      headers: { authorization: "Bearer test-app" },
    });
    expect(held.json().status).toBe("reconciliation_required");
    expect((await restarted.inject(request)).statusCode).toBe(503);
    expect(payCalls()).toBe(1);
  });

  it("releases and cancels a revoked agent's orphan mandate before accepting requests", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-orphan-hold-"));
    temporaryDirs.push(directory);
    const statePath = join(directory, "gateway.json");
    let releases = 0;
    const { app } = fixture({
      statePath,
      agent: { ...agent, status: "revoked" },
      seedMandate: activeMandate(),
      releaseMandate: async () => {
        releases++;
      },
    });
    openApps.push(app);
    const listed = await app.inject({
      method: "GET",
      url: "/v1/app/mandates",
      headers: { authorization: "Bearer test-app" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items[0].status).toBe("cancelled");
    expect(releases).toBe(1);
    await app.close();
    openApps.pop();
    const { app: restarted } = fixture({
      statePath,
      agent: { ...agent, status: "revoked" },
      seedMandate: activeMandate(),
      releaseMandate: async () => {
        releases++;
      },
    });
    openApps.push(restarted);
    const afterRestart = await restarted.inject({
      method: "GET",
      url: "/v1/app/mandates",
      headers: { authorization: "Bearer test-app" },
    });
    expect(afterRestart.json().items[0].status).toBe("cancelled");
    expect(releases).toBe(1);
  });

  it("refuses readiness if an orphan mandate hold cannot be released", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-orphan-failure-"));
    temporaryDirs.push(directory);
    const statePath = join(directory, "gateway.json");
    const { app } = fixture({
      statePath,
      agent: { ...agent, status: "revoked" },
      seedMandate: activeMandate(),
      releaseMandate: async () => {
        throw new Error("Hold ledger unavailable");
      },
    });
    openApps.push(app);
    await expect(app.ready()).rejects.toThrow("Hold ledger unavailable");
    const saved = JSON.parse(readFileSync(statePath, "utf8")) as {
      payload: { mandates: Mandate[] };
    };
    expect(saved.payload.mandates[0].status).toBe("active");
  });

  it("keeps a fresh pairing pending when its audit anchor fails, then retries safely", async () => {
    const { app, deps } = fixture({ seedMandate: activeMandate() });
    openApps.push(app);
    const key = newAgentKey();
    const pair = await app.inject({
      method: "POST",
      url: "/v1/oauth/device_authorization",
      payload: {
        client_name: "Claude new identity",
        provider: "anthropic",
        agent_public_key: key.publicKey,
        requested_scopes: [
          "wallet:pay",
          "wallet:mandate",
          "wallet:history:self",
        ],
      },
    });
    expect(pair.statusCode).toBe(200);
    const userCode = pair.json().user_code as string;
    const consent = await app.inject({
      method: "GET",
      url: `/v1/app/pairing/${userCode}`,
      headers: { authorization: "Bearer test-app" },
    });
    expect(consent.statusCode).toBe(200);
    expect(consent.json().replacement_candidates).toEqual([]);
    const body = {
      verification: {
        action_hash: consent.json().approval.payload_hash,
        device_signature: "test-biometric-proof",
        request_number: pair.json().request_number,
      },
    };
    const workingAnchor = deps.anchorAudit;
    deps.anchorAudit = async () => {
      throw new Error("Audit anchor unavailable");
    };
    const failed = await app.inject({
      method: "POST",
      url: `/v1/app/pairing/${userCode}/approve`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "failed-audit-anchor",
      },
      payload: body,
    });
    deps.anchorAudit = workingAnchor;
    expect(failed.statusCode).toBe(503);
    const pending = await app.inject({
      method: "GET",
      url: `/v1/app/pairing/${userCode}`,
      headers: { authorization: "Bearer test-app" },
    });
    expect(pending.json().pairing.status).toBe("pending");
    const oldMandate = await app.inject({
      method: "GET",
      url: "/v1/app/mandates",
      headers: { authorization: "Bearer test-app" },
    });
    expect(oldMandate.json().items[0].status).toBe("active");
    const approved = await app.inject({
      method: "POST",
      url: `/v1/app/pairing/${userCode}/approve`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "retry-after-audit-recovery",
      },
      payload: body,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().agent.lineage).toMatchObject({
      root_agent_id: approved.json().agent.agent_id,
      replaces_agent_id: null,
    });
  });

  it("lists only the app owner's mandates with effective expiry and retained cancellation", async () => {
    const expiredConstraints: Mandate["constraints"] = constraints.map(
      (item) =>
        item.type === "execution_window"
          ? { ...item, not_after: "2026-10-14T11:00:00Z" }
          : item,
    );
    const otherAgent: Agent = {
      ...agent,
      agent_id: "agt_other",
      user_id: "usr_other",
    };
    const { app } = fixture({
      signedAgents: [agent, otherAgent],
      seedMandates: [
        activeMandate(),
        activeMandate({
          mandate_id: "mdt_expired",
          constraints: expiredConstraints,
        }),
        activeMandate({ mandate_id: "mdt_cancelled", status: "cancelled" }),
        activeMandate({
          mandate_id: "mdt_other",
          agent_id: otherAgent.agent_id,
        }),
      ],
    });
    openApps.push(app);
    const missingSession = await app.inject({
      method: "GET",
      url: "/v1/app/mandates",
    });
    expect(missingSession.statusCode).toBe(401);
    const own = await app.inject({
      method: "GET",
      url: "/v1/app/mandates",
      headers: { authorization: "Bearer test-app" },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().next_cursor).toBeNull();
    expect(
      Object.fromEntries(
        own.json().items.map((item: Mandate) => [item.mandate_id, item.status]),
      ),
    ).toEqual({
      mdt_seed: "active",
      mdt_expired: "expired",
      mdt_cancelled: "cancelled",
    });
    expect(own.body).not.toContain("agt_other");
    expect(own.body).not.toContain("main_balance");
    const other = await app.inject({
      method: "GET",
      url: "/v1/app/mandates",
      headers: { authorization: "Bearer other-app" },
    });
    expect(other.json().items.map((item: Mandate) => item.mandate_id)).toEqual([
      "mdt_other",
    ]);
  });

  it("rejects a merchant-signed Stone option under the Black SKU", async () => {
    const locked = activeMandate({
      intent_level: "product",
      constraints: [
        ...constraints,
        {
          type: "product",
          brand: "Nova",
          model: "Quiet 3",
          variant: "Stone",
          condition: "new",
          gtin: "6901234567001",
          skus: null,
          qty: 1,
        },
      ],
    });
    const { app } = fixture({ seedMandate: locked });
    openApps.push(app);
    const response = await payment(
      app,
      locked.mandate_id,
      signedPayreq({
        line_items: [
          {
            sku: "NOVA-Q3-BLK",
            gtin: "6901234567001",
            name: "Nova Quiet 3 headphones",
            condition: "new",
            options: { colour: "Stone", size: "One size" },
            qty: 1,
            unit_price: { amount: 27_900, currency: "CNY" },
          },
        ],
      }),
      "forged-stone-sku",
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().error.rule).toBe("variant_sku_mismatch");
  });

  it("rejects a real Stone SKU under a Black mandate, then accepts it under a Stone mandate with shipping", async () => {
    const locked = (variant: string) =>
      activeMandate({
        intent_level: "product",
        constraints: [
          ...constraints,
          {
            type: "product",
            brand: "Nova",
            model: "Quiet 3",
            variant,
            condition: "new",
            gtin: null,
            skus: null,
            qty: 1,
          },
        ],
      });
    const stoneRequest = signedPayreq({
      amount: { amount: 28_400, currency: "CNY" },
      line_items: [
        {
          type: "product",
          sku: "NOVA-Q3-STN",
          gtin: "6901234567003",
          name: "Nova Quiet 3 headphones",
          condition: "new",
          variant: "Stone",
          options: { colour: "Stone", size: "One size" },
          qty: 1,
          unit_price: { amount: 27_900, currency: "CNY" },
        },
        {
          type: "shipping",
          name: "Standard delivery",
          qty: 1,
          unit_price: { amount: 500, currency: "CNY" },
        },
      ],
    });
    const black = fixture({ seedMandate: locked("Black") });
    openApps.push(black.app);
    const denied = await payment(
      black.app,
      "mdt_seed",
      stoneRequest,
      "stone-on-black",
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.rule).toBe("variant_mismatch");
    expect(black.executed).toHaveLength(0);

    const stone = fixture({ seedMandate: locked("Stone") });
    openApps.push(stone.app);
    const accepted = await payment(
      stone.app,
      "mdt_seed",
      stoneRequest,
      "stone-on-stone",
    );
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().decision.outcome).toBe("STEP_UP");
    const approvals = await stone.app.inject({
      method: "GET",
      url: "/v1/app/approvals",
      headers: { authorization: "Bearer test-app" },
    });
    expect(approvals.json().items[0].lines).toContain("Delivery: 5 CNY");
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
        user_text: "Buy Sony headphones under 300 CNY",
        intent_level: "open",
        constraints,
      },
    });
    expect(created.statusCode).toBe(202);
    const mandateId = created.json().mandate.mandate_id as string;
    expect(created.json().mandate.user_text_source).toBe("agent_reported");
    expect(created.json().mandate.approved_by).toBeNull();
    const beforeApproval = await payment(app, mandateId, signedPayreq());
    expect(beforeApproval.statusCode).toBe(202);
    expect(beforeApproval.json().status).toBe("awaiting_user");
    expect(executed).toHaveLength(0);

    const cards = await app.inject({
      method: "GET",
      url: "/v1/app/approvals",
      headers: { authorization: "Bearer test-app" },
    });
    const mandateCard = cards.json().items[0];
    expect(mandateCard.level).toBe("zero_trust");
    expect(created.json().request_number).toMatch(/^\d{6}$/);
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
          request_number: created.json().request_number,
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
    expect(history.json().items).toEqual([
      expect.objectContaining({ status: "paid" }),
    ]);
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
      payload: {
        description: "Buy Sony headphones",
        user_text: "Buy Sony headphones",
        intent_level: "open",
        constraints,
      },
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

  it("checks a locked colour against signed options and shows the chosen variant for approval", async () => {
    const locked = activeMandate({
      intent_level: "product",
      constraints: [
        ...constraints,
        {
          type: "product",
          brand: "Sony",
          model: "WH-1000XM5",
          variant: "Black",
          condition: "new",
          gtin: null,
          skus: null,
          qty: 1,
        },
      ],
    });
    const { app, executed } = fixture({ seedMandate: locked });
    openApps.push(app);
    const withOptions = (colour: string, order_id: string, nonce: string) =>
      signedPayreq({
        order_id,
        nonce,
        line_items: [
          {
            sku: colour === "Stone" ? "SONY-XM5-STN" : "SONY-XM5-BLK",
            gtin: colour === "Stone" ? "4548736132598" : "4548736132597",
            name: "Sony WH-1000XM5",
            condition: "new",
            options: { colour, size: "One size" },
            qty: 1,
            unit_price: { amount: 27_900, currency: "CNY" },
          },
        ],
      });
    const mismatch = await payment(
      app,
      locked.mandate_id,
      withOptions("Stone", "ord_stone", "nonce-stone"),
      "stone-payment",
    );
    expect(mismatch.statusCode).toBe(403);
    expect(
      mismatch
        .json()
        .decision.checks.find(
          (check: { name: string }) => check.name === "mandate",
        ).detail.reason,
    ).toBe("variant_mismatch");
    expect(executed).toHaveLength(0);

    const black = withOptions("Black", "ord_black", "nonce-black");
    const request = decodeUri(black);
    const switched = encodePaymentRequestUri({
      ...request,
      line_items: [
        {
          ...request.line_items[0],
          options: { colour: "Stone", size: "One size" },
        },
        ...request.line_items.slice(1),
      ],
    });
    const tampered = await payment(
      app,
      locked.mandate_id,
      switched,
      "tampered-colour",
    );
    expect(tampered.statusCode).toBe(400);
    expect(tampered.json().error.code).toBe("payreq_invalid");

    const accepted = await payment(
      app,
      locked.mandate_id,
      black,
      "black-payment",
    );
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().decision.outcome).toBe("STEP_UP");
    const approvals = await app.inject({
      method: "GET",
      url: "/v1/app/approvals",
      headers: { authorization: "Bearer test-app" },
    });
    expect(approvals.json().items[0].lines).toContain(
      "For: 1 x Sony WH-1000XM5 (Black)",
    );
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
      {
        merchant_id: otherMerchant.merchant_id,
        order_id: "ord_other",
        line_items: [
          {
            type: "product",
            sku: "FIELD-COAT-BLK-M",
            gtin: "6901234567101",
            name: "Field Work jacket",
            condition: "new",
            variant: "Black / M",
            options: { colour: "Black", size: "M" },
            qty: 1,
            unit_price: { amount: 27_900, currency: "CNY" },
          },
        ],
      },
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

  it("counts signed shipping toward the policy cap", async () => {
    const larger = activeMandate({
      constraints: constraints.map((item) => {
        if (item.type === "amount_range" || item.type === "budget")
          return { ...item, max: { amount: 40_000, currency: "CNY" } };
        return item;
      }),
    });
    const { app, executed } = fixture({ seedMandate: larger });
    openApps.push(app);
    const response = await payment(
      app,
      "mdt_seed",
      signedPayreq({
        amount: { amount: 30_200, currency: "CNY" },
        line_items: [
          {
            sku: "SONY-XM5-BLK",
            gtin: "4548736132597",
            name: "Sony WH-1000XM5 Black",
            condition: "new",
            qty: 1,
            unit_price: { amount: 29_900, currency: "CNY" },
          },
          {
            type: "shipping",
            name: "Shipping",
            qty: 1,
            unit_price: { amount: 300, currency: "CNY" },
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

  it("allows only one concurrent payment for the same merchant order across mandates", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-order-race-"));
    temporaryDirs.push(directory);
    const keys = [newAgentKey(), newAgentKey()];
    const experienced = keys.map((key, index) => ({
      ...agent,
      agent_id: `agt_race_${index}`,
      public_key: key.publicKey,
      licence: { ...agent.licence, level: "P" as const, clean_purchases: 1 },
    }));
    const { app, deps, railAttempts } = fixture({
      signedAgents: experienced,
      seedMandates: [
        activeMandate({
          agent_id: experienced[0].agent_id,
          agent_key_binding: experienced[0].public_key,
        }),
        activeMandate({
          mandate_id: "mdt_second",
          agent_id: experienced[1].agent_id,
          agent_key_binding: experienced[1].public_key,
        }),
      ],
      riskDelayMs: 25,
      statePath: join(directory, "gateway.json"),
    });
    openApps.push(app);
    let currentApp = app;
    const request = (nonce: string) =>
      signedPayreq({
        nonce,
        amount: { amount: 5_000, currency: "CNY" },
        line_items: [
          {
            sku: "SONY-XM5-BLK",
            gtin: "4548736132597",
            name: "Sony WH-1000XM5 Black",
            condition: "new",
            qty: 1,
            unit_price: { amount: 5_000, currency: "CNY" },
          },
        ],
      });
    const signedPayment = (index: number, mandateId: string, attempt = "") => {
      const path = "/v1/agent/payments";
      const body = JSON.stringify({
        mandate_id: mandateId,
        payment_request: request(`race-${index}${attempt}`),
        price_evidence: [],
        rationale: "Concurrent checkout",
      });
      return currentApp.inject({
        method: "POST",
        url: path,
        headers: {
          ...signAgentRequest({
            method: "POST",
            path,
            body,
            idempotencyKey: `race-${index}${attempt}`,
            agentId: experienced[index].agent_id,
            privateKeyPem: keys[index].privateKeyPem,
            now: new Date("2026-10-14T12:00:00Z").getTime(),
          }),
          "content-type": "application/json",
        },
        payload: body,
      });
    };
    const [first, second] = await Promise.all([
      signedPayment(0, "mdt_seed"),
      signedPayment(1, "mdt_second"),
    ]);
    expect(
      [first.statusCode, second.statusCode].filter((code) => code === 200),
    ).toHaveLength(1);
    expect(railAttempts).toHaveLength(1);
    await app.close();
    openApps.splice(openApps.indexOf(app), 1);
    const restarted = createGateway(deps, {
      agents: [],
      policies: [policy],
    });
    openApps.push(restarted);
    currentApp = restarted;
    const winner = first.statusCode === 200 ? 0 : 1;
    const winningMandate = winner === 0 ? "mdt_seed" : "mdt_second";
    const replay = await signedPayment(winner, winningMandate);
    expect(replay.statusCode).toBe(200);
    const losingMandate = winner === 0 ? "mdt_second" : "mdt_seed";
    const freshOrderRetry = await signedPayment(
      1 - winner,
      losingMandate,
      "-after-restart",
    );
    expect(freshOrderRetry.statusCode).toBe(403);
    expect(freshOrderRetry.json().error.rule).toBe("duplicate_payment");
    expect(railAttempts).toHaveLength(1);
  });

  it("denies pending payment approval and releases its hold on owner revocation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-revoked-payment-"));
    temporaryDirs.push(directory);
    const statePath = join(directory, "gateway.json");
    const { app, deps, railAttempts } = fixture({
      seedMandate: activeMandate(),
      statePath,
    });
    openApps.push(app);
    const pending = await payment(
      app,
      "mdt_seed",
      signedPayreq(),
      "revoke-pending-payment",
    );
    expect(pending.statusCode).toBe(202);
    const revoked = await app.inject({
      method: "POST",
      url: `/v1/app/agents/${agent.agent_id}/revoke`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "revoke-pending-payment-owner",
      },
      payload: { confirmation_agent_id: agent.agent_id },
    });
    expect(revoked.statusCode).toBe(200);
    const card = await app.inject({
      method: "GET",
      url: "/v1/app/approvals",
      headers: { authorization: "Bearer test-app" },
    });
    const paymentCard = card
      .json()
      .items.find(
        (item: { subject_id: string }) =>
          item.subject_id === pending.json().payment_id,
      );
    expect(paymentCard?.status).toBe("rejected");
    const status = await app.inject({
      method: "GET",
      url: `/v1/app/payments/${pending.json().payment_id}`,
      headers: { authorization: "Bearer test-app" },
    });
    expect(status.json().status).toBe("denied");
    expect(railAttempts).toHaveLength(0);
    await app.close();
    openApps.pop();
    const restarted = createGateway(deps, {
      agents: [agent],
      policies: [policy],
      mandates: [activeMandate()],
    });
    openApps.push(restarted);
    const afterRestart = await restarted.inject({
      method: "GET",
      url: `/v1/app/payments/${pending.json().payment_id}`,
      headers: { authorization: "Bearer test-app" },
    });
    expect(afterRestart.json().status).toBe("denied");
    const staleApproval = await restarted.inject({
      method: "POST",
      url: `/v1/app/approvals/${paymentCard.approval_id}/decide`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "stale-revoked-payment-approval",
      },
      payload: {
        decision: "approve",
        verification: {
          action_hash: paymentCard.payload_hash,
          device_signature: "test-biometric-proof",
          request_number: pending.json().request_number,
        },
      },
    });
    expect(staleApproval.statusCode).toBe(403);
    expect(railAttempts).toHaveLength(0);
  });

  it("settles a pending payment only once under concurrent owner approvals", async () => {
    const { app, deps, railAttempts } = fixture({
      seedMandate: activeMandate(),
    });
    openApps.push(app);
    const pending = await payment(
      app,
      "mdt_seed",
      signedPayreq(),
      "approval-race",
    );
    expect(pending.statusCode).toBe(202);
    const cards = await app.inject({
      method: "GET",
      url: "/v1/app/approvals?status=pending",
      headers: { authorization: "Bearer test-app" },
    });
    const card = cards
      .json()
      .items.find(
        (item: { subject_id: string }) =>
          item.subject_id === pending.json().payment_id,
      );
    let releaseLookups!: () => void;
    const bothLookups = new Promise<void>((resolve) => {
      releaseLookups = resolve;
    });
    let lookupCount = 0;
    deps.lookupMerchant = async () => {
      lookupCount++;
      if (lookupCount === 1) releaseLookups();
      await bothLookups;
      return merchant;
    };
    const approve = (key: string) =>
      app.inject({
        method: "POST",
        url: `/v1/app/approvals/${card.approval_id}/decide`,
        headers: {
          authorization: "Bearer test-app",
          "idempotency-key": key,
        },
        payload: {
          decision: "approve",
          verification: {
            action_hash: card.payload_hash,
            device_signature: "test-biometric-proof",
            request_number: pending.json().request_number,
          },
        },
      });
    const decisions = await Promise.all([
      approve("first-approval"),
      approve("second-approval"),
    ]);
    expect(
      decisions.filter((result) => result.statusCode === 200),
    ).toHaveLength(1);
    expect(
      decisions.some((result) => [403, 409, 503].includes(result.statusCode)),
    ).toBe(true);
    expect(railAttempts).toHaveLength(1);
  });
});

function decodeUri(uri: string): PaymentRequest {
  const payload = uri.slice("ecny://pay?d=".length);
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as PaymentRequest;
}
