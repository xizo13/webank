import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type {
  ChainAddresses,
  FiscoChain,
  TransactionEvidence,
} from "@webank/chain";
import {
  ErrorResponseSchema,
  encodePaymentRequestUri,
} from "@webank/contracts";
import type { Hex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import {
  newAgentKey,
  signAgentRequest,
} from "../../../agents/connector-mcp/src/signing.js";
import { canonicalJson } from "../src/crypto.js";
import { createLocalDemoGateway } from "../src/local-demo.js";
import { createShopPaymentNotifier } from "../src/shop-notifier.js";

const merchantKeys = generateKeyPairSync("ed25519");
const publicKey = `0x${merchantKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`;
const merchant = {
  merchant_id: "mch_shopA",
  ed25519_public_key: publicKey,
  legal_name: "Shop A Electronics (mock)",
  uscc: "MOCK-SHOPA-00000001",
  category: "electronics",
  honeypot: false,
  active: true,
};
const addresses = {
  agentWallet: `0x${"1".repeat(40)}`,
  auditAnchor: `0x${"2".repeat(40)}`,
  ecnySim: `0x${"3".repeat(40)}`,
  merchantRegistry: `0x${"4".repeat(40)}`,
  licenceRegistry: `0x${"5".repeat(40)}`,
} as ChainAddresses;
const demoEnv = {
  NODE_ENV: "test",
  WEBANK_LOCAL_DEMO: "1",
  WEBANK_DEMO_APPROVALS: "1",
};

function fixture(callbackFails = false) {
  const evidence = new Map<Hex, TransactionEvidence>();
  const callbacks: Array<{ order_id: string; payment_tx: Hex }> = [];
  const pays: Hex[] = [];
  let txNumber = 0;
  const transaction = () =>
    `0x${(++txNumber).toString(16).padStart(64, "0")}` as Hex;
  const chain = {
    getMerchant: async () => ({
      payout: `0x${"6".repeat(40)}`,
      signingKey: publicKey,
      legalName: merchant.legal_name,
      uscc: merchant.uscc,
      category: merchant.category,
      active: true,
    }),
    pay: async (
      _address: Hex,
      paymentId: Hex,
      merchantId: Hex,
      amount: bigint,
    ) => {
      const hash = transaction();
      pays.push(hash);
      evidence.set(hash, {
        hash,
        status: "success",
        blockNumber: 1n,
        transactionIndex: 0,
        blockTimestampMs: Date.now(),
        blockTimeIso: new Date().toISOString(),
        paidEvents: [
          {
            paymentId,
            merchantId,
            payout: `0x${"6".repeat(40)}`,
            amount,
          },
        ],
        anchoredEvents: [],
      });
      return hash;
    },
    anchor: async (
      _address: Hex,
      recordHash: Hex,
      subjectId: Hex,
      kind: number,
    ) => {
      const hash = transaction();
      evidence.set(hash, {
        hash,
        status: "success",
        blockNumber: 1n,
        transactionIndex: 0,
        blockTimestampMs: Date.now(),
        blockTimeIso: new Date().toISOString(),
        paidEvents: [],
        anchoredEvents: [{ recordHash, subjectId, kind, atMs: Date.now() }],
      });
      return hash;
    },
    getTransactionEvidence: async (hash: Hex) => {
      const item = evidence.get(hash);
      if (!item) throw new Error("Unknown transaction");
      return item;
    },
  } as unknown as FiscoChain;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "http://127.0.0.1:3001/api/merchants")
      return Response.json({ simulated: true, merchants: [merchant] });
    if (url === "http://127.0.0.1:3001/internal/payment-confirmed") {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer local-token",
      });
      expect(pays).toHaveLength(1);
      const body = JSON.parse(String(init?.body)) as {
        order_id: string;
        payment_tx: Hex;
      };
      callbacks.push(body);
      if (callbackFails)
        return Response.json({ error: "shop unavailable" }, { status: 503 });
      return Response.json({ ...body, status: "paid" });
    }
    throw new Error(`Unexpected shop request: ${url}`);
  }) as typeof fetch;
  return { chain, fetcher, callbacks, pays };
}

function signedPayreq() {
  const unsigned = {
    schema: "payreq.v1" as const,
    merchant_id: merchant.merchant_id,
    order_id: `ord_${randomUUID().replaceAll("-", "")}`,
    amount: { amount: 27_900, currency: "CNY" as const },
    line_items: [
      {
        sku: "NOVA-Q3-BLK",
        gtin: "6901234567001",
        name: "Nova Quiet 3",
        condition: "new" as const,
        qty: 1,
        unit_price: { amount: 27_900, currency: "CNY" as const },
      },
    ],
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    nonce: randomUUID(),
  };
  return encodePaymentRequestUri({
    ...unsigned,
    merchant_sig: sign(
      null,
      Buffer.from(canonicalJson(unsigned)),
      merchantKeys.privateKey,
    ).toString("base64url"),
  });
}

describe("loopback FISCO demo composition", () => {
  const apps: Array<Awaited<ReturnType<typeof createLocalDemoGateway>>["app"]> =
    [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  async function makeApp(callbackFails = false) {
    const fixtureData = fixture(callbackFails);
    const result = await createLocalDemoGateway({
      chain: fixtureData.chain,
      addresses,
      merchants: [merchant],
      shopOrigin: "http://127.0.0.1:3001",
      appOrigin: "http://127.0.0.1:8081",
      gatewayOrigin: "http://127.0.0.1:3002",
      shopToken: "local-token",
      fetcher: fixtureData.fetcher,
      env: demoEnv,
    });
    apps.push(result.app);
    return { ...result, ...fixtureData };
  }

  it("requires both opt-ins, loopback origins, and matching shop identity", async () => {
    const data = fixture();
    const base = {
      chain: data.chain,
      addresses,
      merchants: [merchant],
      shopOrigin: "http://127.0.0.1:3001",
      appOrigin: "http://127.0.0.1:8081",
      gatewayOrigin: "http://127.0.0.1:3002",
      shopToken: "local-token",
      fetcher: data.fetcher,
    };
    await expect(
      createLocalDemoGateway({
        ...base,
        env: { ...demoEnv, NODE_ENV: "production" },
      }),
    ).rejects.toThrow("outside production");
    await expect(
      createLocalDemoGateway({
        ...base,
        env: { ...demoEnv, WEBANK_DEMO_APPROVALS: "0" },
      }),
    ).rejects.toThrow("outside production");
    await expect(
      createLocalDemoGateway({
        ...base,
        shopOrigin: "http://localhost:3001",
        env: demoEnv,
      }),
    ).rejects.toThrow("127.0.0.1");
    await expect(
      createLocalDemoGateway({
        ...base,
        merchants: [{ ...merchant, ed25519_public_key: `0x${"0".repeat(64)}` }],
        env: demoEnv,
      }),
    ).rejects.toThrow("Merchant identity mismatch");
  });

  it.each([false, true])(
    "pairs and settles with a verified Paid event; callback fails=%s",
    async (callbackFails) => {
      const { app, loginToken, callbacks, pays } = await makeApp(callbackFails);
      const login = await app.inject({
        method: "POST",
        url: "/demo/login",
        headers: { authorization: `Bearer ${loginToken}` },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json()).toMatchObject({ simulated: true });
      const cookie = login.headers["set-cookie"] as string;
      const appHeaders = { cookie, "idempotency-key": randomUUID() };
      const key = newAgentKey();
      const pairing = await app.inject({
        method: "POST",
        url: "/v1/oauth/device_authorization",
        payload: {
          client_name: "Local Claude",
          provider: "anthropic",
          agent_public_key: key.publicKey,
          requested_scopes: [
            "wallet:pay",
            "wallet:mandate",
            "wallet:history:self",
          ],
        },
      });
      expect(pairing.statusCode).toBe(200);
      const pair = pairing.json();
      const pairCard = await app.inject({
        method: "GET",
        url: `/v1/app/pairing/${pair.user_code}`,
        headers: appHeaders,
      });
      const paired = await app.inject({
        method: "POST",
        url: `/v1/app/pairing/${pair.user_code}/approve`,
        headers: appHeaders,
        payload: {
          verification: {
            action_hash: pairCard.json().approval.payload_hash,
            device_signature: "simulated-local-approval",
            request_number: pair.request_number,
          },
        },
      });
      expect(paired.statusCode).toBe(200);
      const token = await app.inject({
        method: "POST",
        url: "/v1/oauth/token",
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: pair.device_code,
        },
      });
      expect(token.statusCode).toBe(200);
      const auth = token.json();
      async function agentPost(path: string, body: unknown) {
        const json = JSON.stringify(body);
        return app.inject({
          method: "POST",
          url: path,
          headers: {
            ...signAgentRequest({
              method: "POST",
              path,
              body: json,
              idempotencyKey: randomUUID(),
              agentId: auth.agent_id,
              privateKeyPem: key.privateKeyPem,
            }),
            authorization: `Bearer ${auth.access_token}`,
            "content-type": "application/json",
          },
          payload: json,
        });
      }
      const mandate = await agentPost("/v1/agent/mandates", {
        description: "Buy Nova headphones under 300 CNY",
        constraints: [
          { type: "amount_range", max: { amount: 30_000, currency: "CNY" } },
          { type: "categories", allowed: ["electronics"] },
          { type: "budget", max: { amount: 30_000, currency: "CNY" } },
          { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
          {
            type: "execution_window",
            not_before: null,
            not_after: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
      });
      expect(mandate.statusCode).toBe(202);
      const pendingMandate = await app.inject({
        method: "GET",
        url: "/v1/app/approvals",
        headers: appHeaders,
      });
      const mandateCard = pendingMandate
        .json()
        .items.find(
          (item: { subject_id: string }) =>
            item.subject_id === mandate.json().mandate.mandate_id,
        );
      const mandateApproval = await app.inject({
        method: "POST",
        url: `/v1/app/approvals/${mandateCard.approval_id}/decide`,
        headers: { cookie, "idempotency-key": randomUUID() },
        payload: {
          decision: "approve",
          verification: {
            action_hash: mandateCard.payload_hash,
            device_signature: "simulated-local-approval",
          },
        },
      });
      expect(mandateApproval.statusCode).toBe(200);
      expect(mandateApproval.json().mandate.approved_by).toBe(
        "demo_simulation",
      );
      const payment = await agentPost("/v1/agent/payments", {
        mandate_id: mandate.json().mandate.mandate_id,
        payment_request: signedPayreq(),
        price_evidence: [],
        rationale: "Untrusted agent claim",
      });
      expect(payment.statusCode).toBe(202);
      const pendingPayment = await app.inject({
        method: "GET",
        url: "/v1/app/approvals",
        headers: appHeaders,
      });
      const paymentCard = pendingPayment
        .json()
        .items.find(
          (item: { subject_id: string }) =>
            item.subject_id === payment.json().payment_id,
        );
      const approveHeaders = { cookie, "idempotency-key": randomUUID() };
      const decision = await app.inject({
        method: "POST",
        url: `/v1/app/approvals/${paymentCard.approval_id}/decide`,
        headers: approveHeaders,
        payload: {
          decision: "approve",
          verification: {
            action_hash: paymentCard.payload_hash,
            device_signature: "simulated-local-approval",
            request_number: payment.json().request_number,
          },
        },
      });
      expect(pays).toHaveLength(1);
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0]?.payment_tx).toBe(pays[0]);
      if (callbackFails) {
        expect(decision.statusCode).toBe(503);
        expect(decision.json().error).toMatchObject({
          code: "reconciliation_required",
          payment_id: payment.json().payment_id,
          payment_tx: pays[0],
        });
        expect(() => ErrorResponseSchema.parse(decision.json())).not.toThrow();
        const status = await app.inject({
          method: "GET",
          url: `/v1/app/payments/${payment.json().payment_id}`,
          headers: appHeaders,
        });
        expect(status.statusCode).toBe(503);
        expect(status.json().error.payment_tx).toBe(pays[0]);
        const repeated = await app.inject({
          method: "POST",
          url: `/v1/app/approvals/${paymentCard.approval_id}/decide`,
          headers: approveHeaders,
          payload: {
            decision: "approve",
            verification: {
              action_hash: paymentCard.payload_hash,
              device_signature: "simulated-local-approval",
              request_number: payment.json().request_number,
            },
          },
        });
        expect(repeated.statusCode).toBe(503);
        const freshRetry = await app.inject({
          method: "POST",
          url: `/v1/app/approvals/${paymentCard.approval_id}/decide`,
          headers: { cookie, "idempotency-key": randomUUID() },
          payload: {
            decision: "approve",
            verification: {
              action_hash: paymentCard.payload_hash,
              device_signature: "simulated-local-approval",
              request_number: payment.json().request_number,
            },
          },
        });
        expect(freshRetry.statusCode).toBe(503);
        expect(freshRetry.json().error.payment_tx).toBe(pays[0]);
        expect(pays).toHaveLength(1);
        expect(callbacks).toHaveLength(1);
      } else {
        expect(decision.statusCode).toBe(200);
        expect(decision.json().payment.status).toBe("paid");
        expect(decision.json().payment.receipt.chain.payment_tx).toBe(pays[0]);
      }
    },
  );
});

describe("shop callback adapter", () => {
  it("rejects redirect and mismatched confirmation", async () => {
    expect(() =>
      createShopPaymentNotifier({
        shopOrigin: "https://example.com",
        internalToken: "secret",
      }),
    ).toThrow("127.0.0.1");
    const notifier = createShopPaymentNotifier({
      shopOrigin: "http://127.0.0.1:3001",
      internalToken: "secret",
      fetcher: (async () =>
        Response.json({
          order_id: "wrong",
          status: "paid",
          payment_tx: `0x${"1".repeat(64)}`,
        })) as typeof fetch,
    });
    await expect(
      notifier({ orderId: "ord_test", paymentTx: `0x${"1".repeat(64)}` }),
    ).rejects.toThrow("did not match");
  });
});
