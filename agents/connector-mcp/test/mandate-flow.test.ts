import { generateKeyPairSync, sign } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type Agent,
  encodePaymentRequestUri,
  PaymentHistoryResponseSchema,
  type Policy,
} from "@webank/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../../../services/gateway/src/app.js";
import { canonicalJson } from "../../../services/gateway/src/crypto.js";
import { WeBankConnector } from "../src/client.js";
import { createConnectorServer } from "../src/index.js";
import { newAgentKey, signAgentRequest } from "../src/signing.js";
import type { CredentialStore, Credentials } from "../src/storage.js";

const merchantKeys = generateKeyPairSync("ed25519");
const merchantPublicKey =
  `0x${merchantKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}` as const;
const clock = new Date("2026-10-14T12:00:00Z");
const policy: Policy = {
  schema: "policy.v1",
  user_id: "usr_test",
  per_payment_max: { amount: 30_000, currency: "CNY" },
  daily_max: { amount: 50_000, currency: "CNY" },
  monthly_max: { amount: 100_000, currency: "CNY" },
  auto_approve_below: { amount: 10_000, currency: "CNY" },
  blocked_categories: ["gift_cards"],
  new_merchant_requires_tap: false,
  treasurer: {
    enabled: false,
    buffer_target: { amount: 0, currency: "CNY" },
    daily_topup_ceiling: { amount: 0, currency: "CNY" },
    monthly_topup_ceiling: { amount: 0, currency: "CNY" },
    protected_main_balance: { amount: 0, currency: "CNY" },
  },
};
const limits = (category: string) => [
  { type: "amount_range", max: { amount: 27_900, currency: "CNY" } },
  { type: "categories", allowed: [category] },
  { type: "budget", max: { amount: 27_900, currency: "CNY" } },
  { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
  {
    type: "execution_window",
    not_before: null,
    not_after: "2026-10-15T00:00:00Z",
  },
];
function signedUri(
  currency: "CNY" | "USD" = "CNY",
  nonce = "mandate-flow-nonce",
) {
  const unsigned = {
    schema: "payreq.v1" as const,
    merchant_id: "mch_shopA",
    order_id: "ord_test",
    amount: { amount: 27_900, currency },
    line_items: [
      {
        type: "product" as const,
        sku: "NOVA-Q3-BLK",
        gtin: "6901234567001",
        name: "Nova Quiet 3 Black",
        condition: "new",
        variant: "Black",
        options: { colour: "Black", size: "One size" },
        qty: 1,
        unit_price: { amount: 27_900, currency },
      },
      {
        type: "shipping" as const,
        name: "Shipping",
        qty: 1 as const,
        unit_price: { amount: 0, currency },
      },
    ],
    expires_at: "2026-10-15T00:00:00Z",
    nonce,
  };
  const merchant_sig = sign(
    null,
    Buffer.from(canonicalJson(unsigned)),
    merchantKeys.privateKey,
  ).toString("base64url");
  return encodePaymentRequestUri({ ...unsigned, merchant_sig });
}

describe("agent-facing mandate flow through MCP and Gateway HTTP", () => {
  const close: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const task of close.splice(0)) await task();
  });

  it("shows the first L mandate, hard-rule denial, missing mandate, and pending payment behavior", async () => {
    const key = newAgentKey();
    const agent: Agent = {
      schema: "agent.v1",
      agent_id: "agt_test",
      user_id: "usr_test",
      display_name: "Claude",
      provider: "Anthropic",
      public_key: key.publicKey,
      scopes: ["wallet:pay", "wallet:mandate", "wallet:history:self"],
      licence: { level: "L", points: 0, clean_purchases: 0, drills_passed: 0 },
      status: "active",
      created_at: clock.toISOString(),
      last_used_at: null,
    };
    const gateway = createGateway(
      {
        authenticateAgent: async (request) =>
          request.headers.authorization === "Bearer test-agent" ? agent : null,
        authenticateApp: async (request) =>
          request.headers.authorization === "Bearer test-app"
            ? "usr_test"
            : null,
        demoApprovalsEnabled: true,
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
        recordNumberMatchFailure: async () => {},
        lookupMerchant: async (id) =>
          id === "mch_shopA"
            ? {
                merchant_id: id,
                name: "Shop A",
                legal_name: "Shop A (mock)",
                uscc: "MOCK123",
                category: "electronics",
                first_seen: false,
                honeypot: false,
                public_key: merchantPublicKey,
              }
            : null,
        reserveMandate: async () => true,
        releaseMandate: async () => {},
        assessRisk: async () => ({
          result: "pass",
          signals: [],
          explanation: "Clear",
        }),
        evaluateGuardian: async () => ({
          verdict: "pass",
          reasons: ["Clear"],
          user_explanation: "Clear",
        }),
        executePayment: async () => `0x${"1".repeat(64)}`,
        anchorAudit: async () => `0x${"2".repeat(64)}`,
        signReceipt: async () => "test-signature",
        now: () => clock,
      },
      { agents: [agent], policies: [policy] },
    );
    close.push(() => gateway.close());
    let stored: Credentials | null = {
      ...key,
      agentId: agent.agent_id,
      accessToken: "test-agent",
      tokenExpiresAt: Date.now() + 900_000,
    };
    const store: CredentialStore = {
      load: async () => stored,
      save: async (value: Credentials) => {
        stored = structuredClone(value);
      },
      clear: async () => {
        stored = null;
      },
    };
    const connector = new WeBankConnector(
      new URL("http://127.0.0.1:8787"),
      store,
      async (input, init = {}) => {
        const url = new URL(String(input));
        const result = await gateway.inject({
          method: (init.method || "GET") as "GET" | "POST",
          url: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          ...(init.body ? { payload: String(init.body) } : {}),
        });
        return new Response(result.body, {
          status: result.statusCode,
          headers: { "content-type": "application/json" },
        });
      },
      async () => {},
      () => clock.getTime(),
    );
    const server = createConnectorServer(connector);
    const client = new Client({ name: "mandate-flow", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close.push(async () => {
      await client.close();
      await server.close();
    });

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain("get_wallet_status");
    expect(tools.tools.map((tool) => tool.name)).toContain("wait_for_approval");
    expect(tools.tools.map((tool) => tool.name)).toContain("disconnect_webank");
    const walletBefore = await client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    expect(walletBefore.structuredContent).toMatchObject({
      state: "connected",
      agent_id: agent.agent_id,
    });
    const mandateTool = tools.tools.find(
      (tool) => tool.name === "create_mandate",
    );
    expect(mandateTool?.description).toContain("open complete example");
    expect(mandateTool?.description).toContain("product complete example");
    expect(mandateTool?.description).toContain("listing complete example");
    expect(JSON.stringify(mandateTool?.inputSchema)).toContain("intent_level");
    expect(JSON.stringify(mandateTool?.inputSchema)).toContain("variant");
    const first = await client.callTool({
      name: "create_mandate",
      arguments: {
        description: "Buy black Nova headphones",
        user_text: "Buy black Nova headphones",
        intent_level: "open",
        constraints: limits("electronics"),
      },
    });
    expect(first.isError).not.toBe(true);
    const firstContent = first.structuredContent as Record<string, unknown>;
    expect(firstContent.status).toBe("pending_user");
    expect(firstContent.mandate_id).toMatch(/^mdt_/);
    expect(firstContent.level).toBe("zero_trust");
    expect(firstContent.request_number).toMatch(/^\d{6}$/);
    const cards = await gateway.inject({
      method: "GET",
      url: "/v1/app/approvals?status=pending",
      headers: { authorization: "Bearer test-app" },
    });
    expect(cards.json().items[0].level).toBe("zero_trust");
    expect(JSON.stringify(cards.json())).not.toContain(
      String(firstContent.request_number),
    );
    const blocked = await client.callTool({
      name: "create_mandate",
      arguments: {
        description: "Buy a gift card",
        user_text: "Buy a gift card",
        intent_level: "open",
        constraints: limits("gift_cards"),
      },
    });
    expect(blocked.isError).toBe(true);
    expect(
      (blocked.structuredContent as { error: { rule: string } }).error.rule,
    ).toBe("category_blocked");
    const overCap = await client.callTool({
      name: "create_mandate",
      arguments: {
        description: "Buy headphones",
        user_text: "Buy headphones",
        intent_level: "open",
        constraints: limits("electronics").map((item) =>
          item.type === "amount_range"
            ? { ...item, max: { amount: 30_001, currency: "CNY" } }
            : item,
        ),
      },
    });
    expect(
      (overCap.structuredContent as { error: { rule: string } }).error.rule,
    ).toBe("over_per_payment_cap");
    const missing = await client.callTool({
      name: "request_payment",
      arguments: {
        payment_request: signedUri(),
        price_evidence: [],
        rationale: "Buy headphones",
      },
    });
    expect(missing.isError).toBe(true);
    expect(
      (
        missing.structuredContent as {
          error: { rule: string; detail: { required_fields: string[] } };
        }
      ).error,
    ).toMatchObject({
      rule: "mandate_required",
      detail: {
        required_fields: [
          "description",
          "user_text",
          "intent_level",
          "constraints",
        ],
      },
    });
    const pending = await client.callTool({
      name: "request_payment",
      arguments: {
        mandate_id: firstContent.mandate_id,
        payment_request: signedUri(),
        price_evidence: [],
        rationale: "Buy headphones",
      },
    });
    expect((pending.structuredContent as Record<string, unknown>).status).toBe(
      "awaiting_user",
    );
    expect(
      (pending.structuredContent as Record<string, unknown>).approval_id,
    ).toBe(firstContent.approval_id);
    const card = cards.json().items[0];
    const waitStartedAt = Date.now();
    let waitResolved = false;
    const waiting = client
      .callTool({
        name: "wait_for_approval",
        arguments: { approval_id: card.approval_id, wait_seconds: 55 },
      })
      .then((result) => {
        waitResolved = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(waitResolved).toBe(false);
    const approved = await gateway.inject({
      method: "POST",
      url: `/v1/app/approvals/${card.approval_id}/decide`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "approve-first-mandate",
      },
      payload: {
        decision: "approve",
        verification: {
          action_hash: card.payload_hash,
          device_signature: "test-biometric-proof",
          request_number: firstContent.request_number,
        },
      },
    });
    expect(approved.statusCode).toBe(200);
    const approvedWait = await waiting;
    expect(Date.now() - waitStartedAt).toBeLessThan(2_000);
    expect(approvedWait.structuredContent).toMatchObject({
      status: "approved",
      approval_id: card.approval_id,
    });
    const active = await client.callTool({
      name: "get_mandate_status",
      arguments: { mandate_id: firstContent.mandate_id },
    });
    expect((active.structuredContent as Record<string, unknown>).status).toBe(
      "active",
    );
    const wrongCurrency = await client.callTool({
      name: "request_payment",
      arguments: {
        mandate_id: firstContent.mandate_id,
        payment_request: signedUri("USD", "wrong-currency-nonce"),
        price_evidence: [],
        rationale: "Buy headphones",
      },
    });
    expect(wrongCurrency.isError).toBe(true);
    expect(wrongCurrency.content[0]).toMatchObject({
      type: "text",
      text: "WeBank request failed (400: payreq_invalid)",
    });
    const payment = await client.callTool({
      name: "request_payment",
      arguments: {
        mandate_id: firstContent.mandate_id,
        payment_request: signedUri(),
        price_evidence: [],
        rationale: "Buy headphones",
      },
    });
    const paymentContent = payment.structuredContent as Record<string, unknown>;
    expect(paymentContent.status).toBe("awaiting_user");
    const rejected = await gateway.inject({
      method: "POST",
      url: `/v1/app/approvals/${paymentContent.approval_id}/decide`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "reject-first-payment",
      },
      payload: { decision: "reject" },
    });
    expect(rejected.statusCode).toBe(200);
    const status = await client.callTool({
      name: "get_payment_status",
      arguments: { payment_id: paymentContent.payment_id },
    });
    expect(status.structuredContent).toMatchObject({
      status: "denied",
      explanation: "You rejected the payment in the WeBank app.",
      error: {
        code: "approval_rejected",
        rule: "user_rejected",
        fixable: false,
      },
    });
    expect(status.structuredContent).toMatchObject({
      amount_display: "¥279.00",
      receipt: { amount: { amount: 27_900, currency: "CNY" } },
    });
    expect(
      (status.structuredContent as { receipt: { amount: unknown } }).receipt
        .amount,
    ).toEqual({ amount: 27_900, currency: "CNY" });
    const ownerPayment = await gateway.inject({
      method: "GET",
      url: `/v1/app/payments/${paymentContent.payment_id}`,
      headers: { authorization: "Bearer test-app" },
    });
    expect(ownerPayment.statusCode).toBe(200);
    expect((status.structuredContent as { receipt: unknown }).receipt).toEqual(
      ownerPayment.json().receipt,
    );
    const historyPath = "/v1/agent/payments";
    const historyWire = await gateway.inject({
      method: "GET",
      url: historyPath,
      headers: {
        ...signAgentRequest({
          method: "GET",
          path: historyPath,
          body: "",
          idempotencyKey: "history-display-check",
          agentId: agent.agent_id,
          privateKeyPem: key.privateKeyPem,
          now: clock.getTime(),
        }),
        authorization: "Bearer test-agent",
      },
    });
    expect(historyWire.statusCode).toBe(200);
    expect(historyWire.json().items[0].amount).toEqual({
      amount: 27_900,
      currency: "CNY",
    });
    expect(() =>
      PaymentHistoryResponseSchema.parse(historyWire.json()),
    ).not.toThrow();
    const historyTool = await client.callTool({
      name: "list_my_payments",
      arguments: { limit: 10 },
    });
    expect(
      (historyTool.structuredContent as { items: Array<{ amount: unknown }> })
        .items[0].amount,
    ).toEqual({ amount: 27_900, currency: "CNY", display: "¥279.00" });
    const frozen = await gateway.inject({
      method: "POST",
      url: `/v1/app/agents/${agent.agent_id}/freeze`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "freeze-flow",
      },
      payload: {},
    });
    expect(frozen.statusCode).toBe(200);
    const walletFrozen = await client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    expect(walletFrozen.structuredContent).toMatchObject({ state: "frozen" });
    const frozenPay = await client.callTool({
      name: "request_payment",
      arguments: {
        mandate_id: firstContent.mandate_id,
        payment_request: signedUri("CNY", "frozen-retry-nonce"),
        price_evidence: [],
        rationale: "Retry after freeze",
      },
    });
    expect(frozenPay.isError).toBe(true);
    expect(JSON.stringify(frozenPay.content)).toContain(
      "Only the user can Unfreeze",
    );
    const disconnected = await client.callTool({
      name: "disconnect_webank",
      arguments: {},
    });
    expect(disconnected.structuredContent).toMatchObject({ state: "revoked" });
    expect(stored).toBeNull();
    const walletGone = await client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    expect(walletGone.structuredContent).toMatchObject({ state: "not_paired" });
  });
});
