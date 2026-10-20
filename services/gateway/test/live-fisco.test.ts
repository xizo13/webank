import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { type ChainAddresses, connectFisco } from "@webank/chain";
import {
  decodePaymentRequestUri,
  encodePaymentRequestUri,
  type Policy,
} from "@webank/contracts";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  newAgentKey,
  signAgentRequest,
} from "../../../agents/connector-mcp/src/signing.js";
import { createGateway } from "../src/app.js";
import { canonicalJson } from "../src/crypto.js";
import { createFiscoGatewayAdapters } from "../src/fisco.js";
import type { GatewayDependencies } from "../src/types.js";

const live = process.env.WEBANK_LIVE_GATEWAY === "1";
const shopUrl = process.env.WEBANK_SHOP_URL ?? "http://127.0.0.1:3001";
type LiveJson = {
  user_code: string;
  device_code: string;
  request_number: string;
  agent_id: string;
  access_token: string;
  mandate: { mandate_id: string };
  payment_id: string;
  decision: { outcome: string };
  approval: { approval_id: string; subject_id: string; payload_hash: string };
  items: Array<{
    approval_id: string;
    subject_id: string;
    payload_hash: string;
    summary: string;
  }>;
  payment: {
    status: string;
    receipt: {
      chain: { payment_tx: Hex; audit_tx: Hex };
      webank_sig: string;
      [key: string]: unknown;
    };
  };
};

async function shop(operation: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${shopUrl}/api/shop`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation, ...body }),
  });
  if (!response.ok)
    throw new Error(
      `Shop ${operation}: ${response.status} ${await response.text()}`,
    );
  return response.json() as Promise<Record<string, unknown>>;
}

describe.runIf(live)("live signed checkout through Gateway and FISCO", () => {
  it("pairs, steps up, settles, anchors, denies tampering, and freezes over HTTP", async () => {
    const privateKey = process.env.FISCO_GATEWAY_PRIVATE_KEY;
    if (!privateKey?.startsWith("0x"))
      throw new Error("FISCO_GATEWAY_PRIVATE_KEY is required");
    const addresses = JSON.parse(
      await readFile(
        new URL("../../../scripts/chain/addresses.json", import.meta.url),
        "utf8",
      ),
    ) as ChainAddresses;
    const merchantSeed = JSON.parse(
      await readFile(
        new URL("../../../scripts/chain/merchants.json", import.meta.url),
        "utf8",
      ),
    ) as {
      merchants: Array<{
        merchant_id: string;
        honeypot: boolean;
        ed25519_public_key: string;
      }>;
    };
    const shopMerchants = (await (
      await fetch(`${shopUrl}/api/merchants`)
    ).json()) as {
      merchants: Array<{ merchant_id: string; ed25519_public_key: string }>;
    };
    for (const id of ["mch_shopA", "mch_decoy"]) {
      const seeded = merchantSeed.merchants.find(
        (item) => item.merchant_id === id,
      );
      const serving = shopMerchants.merchants.find(
        (item) => item.merchant_id === id,
      );
      expect(seeded?.ed25519_public_key).toBe(serving?.ed25519_public_key);
    }
    const chain = await connectFisco({
      rpcUrl: "http://127.0.0.1:8545",
      privateKey: privateKey as `0x${string}`,
    });
    const signer = generateKeyPairSync("ed25519");
    const chainAdapter = createFiscoGatewayAdapters({
      chain,
      addresses,
      classifyMerchant: async (id) => {
        const entry = merchantSeed.merchants.find(
          (item) => item.merchant_id === id,
        );
        return entry
          ? { name: id, first_seen: false, honeypot: entry.honeypot }
          : null;
      },
    });
    const policy: Policy = {
      schema: "policy.v1",
      user_id: "usr_live",
      per_payment_max: { amount: 30_000, currency: "CNY" },
      daily_max: { amount: 50_000, currency: "CNY" },
      monthly_max: { amount: 100_000, currency: "CNY" },
      auto_approve_below: { amount: 10_000, currency: "CNY" },
      blocked_categories: ["gift_cards"],
      new_merchant_requires_tap: false,
      treasurer: {
        enabled: false,
        buffer_target: { amount: 0, currency: "CNY" },
        daily_topup_ceiling: { amount: 10_000, currency: "CNY" },
        monthly_topup_ceiling: { amount: 20_000, currency: "CNY" },
        protected_main_balance: { amount: 30_000, currency: "CNY" },
      },
    };
    const deps: GatewayDependencies = {
      ...chainAdapter,
      authenticateApp: async (request) =>
        request.headers.authorization === "Bearer live-app-fixture"
          ? "usr_live"
          : null,
      demoApprovalsEnabled: true,
      demoApprovalVerifier: async (approval, value) => {
        const proof = value as {
          action_hash: string;
          device_signature: string;
        };
        return proof.action_hash === approval.payload_hash &&
          proof.device_signature === "live-biometric-fixture"
          ? "user_biometric"
          : false;
      },
      recordNumberMatchFailure: async () => {},
      reserveMandate: async () => true,
      releaseMandate: async () => {},
      assessRisk: async () => ({
        result: "pass",
        signals: [],
        explanation: "Demo risk fixture",
      }),
      evaluateGuardian: async () => ({
        verdict: "pass",
        reasons: ["Demo Guardian fixture"],
        user_explanation: "Demo Guardian fixture",
      }),
      signReceipt: async (bytes) =>
        sign(null, bytes, signer.privateKey).toString("base64url"),
    };
    const app = createGateway(deps, { agents: [], policies: [policy] });
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    async function post(
      path: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        body: (await response.json()) as LiveJson,
      };
    }
    async function get(path: string, headers: Record<string, string> = {}) {
      const response = await fetch(`${base}${path}`, { headers });
      return {
        status: response.status,
        body: (await response.json()) as LiveJson,
      };
    }
    try {
      const credentials = newAgentKey();
      const pairing = await post("/v1/oauth/device_authorization", {
        client_name: "Live connector",
        provider: "anthropic",
        client_app_name: "Claude Code",
        client_app_id: `app_${createHash("sha256").update("Claude Code").digest("hex")}`,
        agent_public_key: credentials.publicKey,
        requested_scopes: [
          "wallet:pay",
          "wallet:mandate",
          "wallet:history:self",
        ],
      });
      expect(pairing.status).toBe(200);
      const appHeaders = { authorization: "Bearer live-app-fixture" };
      const pairCard = await get(
        `/v1/app/pairing/${pairing.body.user_code}`,
        appHeaders,
      );
      expect(pairCard.status).toBe(200);
      const pairApproval = await post(
        `/v1/app/pairing/${pairing.body.user_code}/approve`,
        {
          verification: {
            action_hash: pairCard.body.approval.payload_hash,
            device_signature: "live-biometric-fixture",
            request_number: pairing.body.request_number,
          },
        },
        { ...appHeaders, "idempotency-key": randomUUID() },
      );
      expect(pairApproval.status).toBe(200);
      const token = await post("/v1/oauth/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pairing.body.device_code,
      });
      expect(token.status).toBe(200);
      async function agentPost(path: string, body: unknown) {
        const json = JSON.stringify(body);
        const signed = signAgentRequest({
          method: "POST",
          path,
          body: json,
          idempotencyKey: randomUUID(),
          agentId: token.body.agent_id,
          privateKeyPem: credentials.privateKeyPem,
        });
        const response = await fetch(`${base}${path}`, {
          method: "POST",
          headers: {
            ...signed,
            authorization: `Bearer ${token.body.access_token}`,
            "content-type": "application/json",
          },
          body: json,
        });
        return {
          status: response.status,
          body: (await response.json()) as LiveJson,
        };
      }
      const constraints = [
        { type: "amount_range", max: { amount: 30_000, currency: "CNY" } },
        { type: "categories", allowed: ["electronics"] },
        { type: "budget", max: { amount: 30_000, currency: "CNY" } },
        { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
        {
          type: "execution_window",
          not_before: null,
          not_after: new Date(Date.now() + 3600_000).toISOString(),
        },
      ];
      const mandate = await agentPost("/v1/agent/mandates", {
        description: "Buy Nova Quiet 3 from Arc Goods",
        user_text: "Buy Nova Quiet 3 from Arc Goods",
        intent_level: "open",
        constraints,
      });
      expect(mandate.status).toBe(202);
      const cards = await get("/v1/app/approvals", appHeaders);
      const mandateCard = cards.body.items.find(
        (item) => item.subject_id === mandate.body.mandate.mandate_id,
      );
      expect(mandateCard).toBeTruthy();
      const approved = await post(
        `/v1/app/approvals/${mandateCard.approval_id}/decide`,
        {
          decision: "approve",
          verification: {
            action_hash: mandateCard.payload_hash,
            device_signature: "live-biometric-fixture",
            request_number: mandate.body.request_number,
          },
        },
        { ...appHeaders, "idempotency-key": randomUUID() },
      );
      expect(approved.status).toBe(200);
      await shop("reset");
      await shop("add_to_cart", {
        sku: "NOVA-Q3-BLK",
        qty: 1,
        options: { colour: "Black", size: "One size" },
      });
      const checkout = await shop("checkout", {
        shipping_address: {
          name: "Lin Demo",
          phone: "13800138000",
          address_line: "88 Demo Road",
          city: "Shenzhen",
          postcode: "518000",
        },
      });
      const payment = await agentPost("/v1/agent/payments", {
        mandate_id: mandate.body.mandate.mandate_id,
        payment_request: checkout.payment_request,
        price_evidence: [],
        rationale: "Agent claim only",
      });
      expect(payment.status).toBe(202);
      expect(payment.body.decision.outcome).toBe("STEP_UP");
      const paymentCards = await get("/v1/app/approvals", appHeaders);
      const paymentCard = paymentCards.body.items.find(
        (item) => item.subject_id === payment.body.payment_id,
      );
      expect(paymentCard).toBeTruthy();
      const paid = await post(
        `/v1/app/approvals/${paymentCard.approval_id}/decide`,
        {
          decision: "approve",
          verification: {
            action_hash: paymentCard.payload_hash,
            device_signature: "live-biometric-fixture",
            request_number: payment.body.request_number,
          },
        },
        { ...appHeaders, "idempotency-key": randomUUID() },
      );
      expect(paid.status).toBe(200);
      expect(paid.body.payment.status).toBe("paid");
      const receipt = paid.body.payment.receipt;
      expect(
        (await chain.getTransactionEvidence(receipt.chain.payment_tx))
          .paidEvents,
      ).toHaveLength(1);
      expect(
        (await chain.getTransactionEvidence(receipt.chain.audit_tx))
          .anchoredEvents,
      ).toHaveLength(1);
      const { webank_sig, ...unsigned } = receipt;
      expect(
        verify(
          null,
          Buffer.from(canonicalJson(unsigned)),
          signer.publicKey,
          Buffer.from(webank_sig, "base64url"),
        ),
      ).toBe(true);
      const changedPayreq = decodePaymentRequestUri(
        String(checkout.payment_request),
      );
      const tampered = await agentPost("/v1/agent/payments", {
        mandate_id: mandate.body.mandate.mandate_id,
        payment_request: encodePaymentRequestUri({
          ...changedPayreq,
          amount: {
            ...changedPayreq.amount,
            amount: changedPayreq.amount.amount + 1,
          },
        }),
        price_evidence: [],
        rationale: "Tampered URI",
      });
      expect(tampered.status).toBe(400);
      const audit = await get("/v1/app/audit", appHeaders);
      expect(
        audit.body.items.some((item) => item.summary.includes("DENIED")),
      ).toBe(true);
      const frozen = await post(
        `/v1/app/agents/${token.body.agent_id}/freeze`,
        {},
        { ...appHeaders, "idempotency-key": randomUUID() },
      );
      expect(frozen.status).toBe(200);
      const frozenAttempt = await agentPost("/v1/agent/mandates", {
        description: "Another purchase",
        user_text: "Another purchase",
        intent_level: "open",
        constraints,
      });
      expect(frozenAttempt.status).toBe(401);
    } finally {
      await app.close();
    }
  }, 120_000);
});
