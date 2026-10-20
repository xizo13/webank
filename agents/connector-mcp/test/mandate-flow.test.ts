import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type Agent,
  encodePaymentRequestUri,
  PaymentHistoryResponseSchema,
  type Policy,
} from "@webank/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  GET as shopGet,
  POST as shopPost,
} from "../../../apps/shops/app/api/shop/route.js";
import { POST as shopDrillVisibility } from "../../../apps/shops/app/internal/drill-visibility/route.js";
import { merchantPublicKeyHex } from "../../../apps/shops/lib/signing.js";
import { resetDemo } from "../../../apps/shops/lib/store.js";
import { shopMcpServer } from "../../../apps/shops/mcp/server.js";
import { createGateway } from "../../../services/gateway/src/app.js";
import { canonicalJson } from "../../../services/gateway/src/crypto.js";
import { WeBankConnector } from "../src/client.js";
import { createConnectorServer } from "../src/index.js";
import { newAgentKey, signAgentRequest } from "../src/signing.js";
import {
  type CredentialStore,
  type Credentials,
  clientAppIdentity,
} from "../src/storage.js";

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
const limits = (category: string, amount = 27_900) => [
  { type: "amount_range", max: { amount, currency: "CNY" } },
  { type: "categories", allowed: [category] },
  { type: "budget", max: { amount, currency: "CNY" } },
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
  amount = 27_900,
  orderId = "ord_test",
  decoy = false,
) {
  const unsigned = {
    schema: "payreq.v1" as const,
    merchant_id: decoy ? "mch_decoy" : "mch_shopA",
    order_id: orderId,
    amount: { amount, currency },
    line_items: [
      {
        type: "product" as const,
        sku: decoy ? "REWARD-GIFT-500" : "NOVA-Q3-BLK",
        gtin: decoy ? "6901234567999" : "6901234567001",
        name: decoy ? "Instant reward voucher" : "Nova Quiet 3 Black",
        condition: "new",
        variant: decoy ? "Standard" : "Black",
        options: decoy ? {} : { colour: "Black", size: "One size" },
        qty: 1,
        unit_price: { amount, currency },
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

  it("shows the first Amber mandate, hard-rule denial, missing mandate, and pending payment behavior", async () => {
    const key = newAgentKey();
    const agent: Agent & { client_app_id: string; client_app_name: string } = {
      schema: "agent.v1",
      agent_id: "agt_test",
      user_id: "usr_test",
      display_name: "Claude",
      provider: "Anthropic",
      client_app_id: clientAppIdentity("mandate-flow").id,
      client_app_name: "mandate-flow",
      public_key: key.publicKey,
      scopes: ["wallet:pay", "wallet:mandate", "wallet:history:self"],
      licence: {
        level: "AMBER",
        clean_purchases: 0,
        drills_passed: 0,
        drills_failed: 0,
        flags_30d: 0,
        reason: "New agent, no history yet",
        updated_at: clock.toISOString(),
      },
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
          reason_code: "none",
          reasons: ["Clear"],
          user_explanation: "Clear",
        }),
        preflightPayment: async () => {},
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
        approval_timing: "upfront",
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
      "Only the owner can Unfreeze",
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

  it("takes Amber one-card checkout, Green auto and reviewed payments, and Red denial through MCP", async () => {
    const shopDataDir = mkdtempSync(join(tmpdir(), "webank-trust-shop-"));
    const priorShopDataDir = process.env.SHOP_DATA_DIR;
    const priorShopToken = process.env.SHOP_INTERNAL_TOKEN;
    const originalFetch = globalThis.fetch;
    process.env.SHOP_DATA_DIR = shopDataDir;
    process.env.SHOP_INTERNAL_TOKEN = "isolated-trust-test-token";
    resetDemo({ clearDrill: true });
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.origin !== "http://127.0.0.1:3001")
        return originalFetch(input, init);
      const method = init.method || "GET";
      const request = new Request(url, init);
      Object.defineProperty(request, "nextUrl", { value: url });
      return method === "POST"
        ? shopPost(request as Parameters<typeof shopPost>[0])
        : shopGet(request as Parameters<typeof shopGet>[0]);
    };
    const shopClient = new Client({
      name: "isolated-demo-shop",
      version: "1.0.0",
    });
    const [shopClientTransport, shopServerTransport] =
      InMemoryTransport.createLinkedPair();
    await shopMcpServer.connect(shopServerTransport);
    await shopClient.connect(shopClientTransport);
    close.push(async () => {
      await shopClient.close();
      await shopMcpServer.close();
      globalThis.fetch = originalFetch;
      if (priorShopDataDir === undefined) delete process.env.SHOP_DATA_DIR;
      else process.env.SHOP_DATA_DIR = priorShopDataDir;
      if (priorShopToken === undefined) delete process.env.SHOP_INTERNAL_TOKEN;
      else process.env.SHOP_INTERNAL_TOKEN = priorShopToken;
      rmSync(shopDataDir, { recursive: true, force: true });
    });
    const shopTools = await shopClient.listTools();
    expect(shopTools.tools.map((tool) => tool.name)).toContain("checkout");
    expect(shopTools.tools.map((tool) => tool.name)).not.toContain(
      "start_fire_drill",
    );
    const search = await shopClient.callTool({
      name: "search_products",
      arguments: { query: "Nova Quiet 3" },
    });
    expect(search.isError).not.toBe(true);
    expect(JSON.stringify(search.structuredContent)).toContain(
      '"shop_name":"BaoTao Shop"',
    );
    const product = await shopClient.callTool({
      name: "get_product",
      arguments: { sku: "NOVA-Q3-BLK" },
    });
    expect(product.structuredContent).toMatchObject({
      shop: "shopA",
      shop_name: "BaoTao Shop",
    });
    const setShopPrice = async (amount: number) => {
      const result = await shopPost(
        new Request("http://127.0.0.1:3001/api/shop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operation: "set_price",
            sku: "NOVA-Q3-BLK",
            amount,
          }),
        }) as Parameters<typeof shopPost>[0],
      );
      expect(result.status).toBe(200);
    };
    const checkoutFromShop = async (sku: string) => {
      const added = await shopClient.callTool({
        name: "add_to_cart",
        arguments: {
          sku,
          qty: 1,
          options:
            sku === "NOVA-Q3-BLK" ? { colour: "Black", size: "One size" } : {},
        },
      });
      expect(added.isError).not.toBe(true);
      const checkout = await shopClient.callTool({
        name: "checkout",
        arguments: {
          shipping_address: {
            name: "Test Shopper",
            phone: "13800138000",
            address_line: "1 Test Street",
            city: "Shanghai",
            postcode: "200000",
          },
        },
      });
      expect(checkout.isError).not.toBe(true);
      expect(checkout.structuredContent).toMatchObject({
        wallet_submission: "not_performed_by_shop",
        payment_request: expect.stringMatching(/^ecny:\/\/pay\?d=/),
      });
      return checkout.structuredContent as {
        order_id: string;
        payment_request: string;
        total: { amount: number; currency: string };
      };
    };
    const setShopDrillVisibility = async (enabled: boolean) => {
      const response = await shopDrillVisibility(
        new Request("http://127.0.0.1:3001/internal/drill-visibility", {
          method: "POST",
          headers: {
            authorization: "Bearer isolated-trust-test-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ enabled }),
        }) as Parameters<typeof shopDrillVisibility>[0],
      );
      expect(response.status).toBe(200);
      expect((await response.json()).drill_visible).toBe(enabled);
    };
    const key = newAgentKey();
    const agent: Agent & { client_app_id: string; client_app_name: string } = {
      schema: "agent.v1",
      agent_id: "agt_attended_paid",
      user_id: "usr_test",
      display_name: "Claude",
      provider: "Anthropic",
      client_app_id: clientAppIdentity("attended-paid").id,
      client_app_name: "attended-paid",
      public_key: key.publicKey,
      scopes: ["wallet:pay", "wallet:mandate", "wallet:history:self"],
      licence: {
        level: "AMBER",
        clean_purchases: 0,
        drills_passed: 0,
        drills_failed: 0,
        flags_30d: 0,
        reason: "New agent, no history yet",
        updated_at: clock.toISOString(),
      },
      status: "active",
      created_at: clock.toISOString(),
      last_used_at: null,
    };
    const executed: string[] = [];
    let drillVisible = false;
    const gateway = createGateway(
      {
        authenticateAgent: async (request) =>
          request.headers.authorization === "Bearer test-agent" ? agent : null,
        authenticateApp: async (request) =>
          request.headers.authorization === "Bearer test-app"
            ? "usr_test"
            : null,
        demoApprovalsEnabled: true,
        demoTrustControlsEnabled: true,
        setDrillVisibility: async (enabled) => {
          await setShopDrillVisibility(enabled);
          drillVisible = enabled;
        },
        setTrustLight: async () => `0x${"3".repeat(64)}`,
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
          id === "mch_shopA" || id === "mch_decoy"
            ? {
                merchant_id: id,
                name: id === "mch_decoy" ? "Reward Vault" : "BaoTao Shop",
                legal_name:
                  id === "mch_decoy" ? "Reward Vault (mock)" : "Shop A (mock)",
                uscc: "MOCK123",
                category: id === "mch_decoy" ? "gift_cards" : "electronics",
                first_seen: false,
                honeypot: id === "mch_decoy",
                public_key: merchantPublicKeyHex(
                  id === "mch_decoy" ? "decoy" : "shopA",
                ),
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
          reason_code: "none",
          reasons: ["Clear"],
          user_explanation: "Clear",
        }),
        preflightPayment: async () => {},
        executePayment: async ({ paymentId }) => {
          executed.push(paymentId);
          return `0x${"1".repeat(64)}`;
        },
        anchorAudit: async () => `0x${"2".repeat(64)}`,
        signReceipt: async () => "test-signature",
        now: () => clock,
      },
      { agents: [agent], policies: [policy] },
    );
    close.push(() => gateway.close());
    const credentials: Credentials = {
      ...key,
      agentId: agent.agent_id,
      accessToken: "test-agent",
      tokenExpiresAt: Date.now() + 900_000,
    };
    const store: CredentialStore = {
      load: async () => credentials,
      save: async () => {},
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
    const client = new Client({ name: "attended-paid", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close.push(async () => {
      await client.close();
      await server.close();
    });

    const availableTools = await client.listTools();
    expect(availableTools.tools.map((tool) => tool.name)).not.toContain(
      "start_fire_drill",
    );
    expect(availableTools.tools.map((tool) => tool.name)).not.toContain(
      "fast_forward_green",
    );
    const agentControlAttempt = await gateway.inject({
      method: "POST",
      url: "/v1/app/demo/drills/start",
      headers: {
        authorization: "Bearer test-agent",
        "idempotency-key": "agent-cannot-start-drill",
      },
      payload: {},
    });
    expect(agentControlAttempt.statusCode).toBe(401);
    expect(drillVisible).toBe(false);

    const mandate = await client.callTool({
      name: "create_mandate",
      arguments: {
        description: "Buy black Nova headphones",
        user_text: "Buy black Nova headphones",
        intent_level: "open",
        constraints: limits("electronics", 30_000),
      },
    });
    expect(mandate.isError).not.toBe(true);
    const mandateContent = mandate.structuredContent as Record<string, unknown>;
    expect(mandateContent).toMatchObject({
      status: "pending_checkout",
      approval_timing: "payment",
    });
    expect(mandateContent).not.toHaveProperty("approval_id");
    const before = await gateway.inject({
      method: "GET",
      url: "/v1/app/approvals?status=pending",
      headers: { authorization: "Bearer test-app" },
    });
    expect(before.json().items).toEqual([]);

    const firstShopCheckout = await checkoutFromShop("NOVA-Q3-BLK");
    expect(firstShopCheckout.total.amount).toBe(28_400);
    const checkoutUri = firstShopCheckout.payment_request;
    const requested = await client.callTool({
      name: "request_payment",
      arguments: {
        mandate_id: mandateContent.mandate_id,
        payment_request: checkoutUri,
        price_evidence: [],
        rationale: "Buy black Nova headphones",
      },
    });
    expect(requested.isError).not.toBe(true);
    const paymentContent = requested.structuredContent as Record<
      string,
      unknown
    >;
    expect(paymentContent).toMatchObject({
      status: "awaiting_user",
      payment_id: expect.stringMatching(/^pay_/),
      approval_id: expect.stringMatching(/^apr_/),
    });
    expect(executed).toHaveLength(0);
    const cards = await gateway.inject({
      method: "GET",
      url: "/v1/app/approvals?status=pending",
      headers: { authorization: "Bearer test-app" },
    });
    expect(cards.json().items).toHaveLength(1);
    const card = cards.json().items[0];
    expect(card).toMatchObject({
      approval_id: paymentContent.approval_id,
      kind: "payment",
      review_schema: "payment_review.v1",
    });
    const review = await gateway.inject({
      method: "GET",
      url: `/v1/app/approvals/${card.approval_id}/review`,
      headers: { authorization: "Bearer test-app" },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json()).toMatchObject({
      schema: "payment_review.v1",
      payment_id: paymentContent.payment_id,
      signed_order: {
        merchant_id: "mch_shopA",
        order_id: firstShopCheckout.order_id,
        amount: { amount: 28_400, currency: "CNY" },
      },
    });
    const approved = await gateway.inject({
      method: "POST",
      url: `/v1/app/approvals/${card.approval_id}/decide`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "attended-paid-approval",
      },
      payload: {
        decision: "approve",
        verification: {
          action_hash: card.payload_hash,
          device_signature: "test-biometric-proof",
          request_number: paymentContent.request_number,
        },
      },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().payment.status).toBe("paid");
    expect(executed).toEqual([paymentContent.payment_id]);
    const paid = await client.callTool({
      name: "get_payment_status",
      arguments: { payment_id: paymentContent.payment_id },
    });
    expect(paid.structuredContent).toMatchObject({
      status: "paid",
      receipt: { amount: { amount: 28_400, currency: "CNY" } },
    });

    const ownerPrepare = await gateway.inject({
      method: "POST",
      url: `/v1/app/demo/agents/${agent.agent_id}/prepare-fast-forward-green`,
      headers: { authorization: "Bearer test-app" },
      payload: {},
    });
    expect(ownerPrepare.statusCode).toBe(200);
    const ownerGreen = await gateway.inject({
      method: "POST",
      url: `/v1/app/demo/agents/${agent.agent_id}/fast-forward-green`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "owner-green-fast-forward",
      },
      payload: {
        simulated: true,
        challenge_id: ownerPrepare.json().challenge_id,
        verification: {
          action_hash: ownerPrepare.json().action_hash,
          device_signature: "test-biometric-proof",
        },
      },
    });
    expect(ownerGreen.statusCode).toBe(200);
    expect(ownerGreen.json().agent.licence.level).toBe("GREEN");
    const greenStatus = await client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    expect(greenStatus.structuredContent).toMatchObject({
      state: "connected",
      licence: { level: "GREEN" },
    });

    await setShopPrice(4_500);
    const greenCheapMandate = await client.callTool({
      name: "create_mandate",
      arguments: {
        description: "Buy a discounted Nova item for ¥50",
        user_text: "Buy a discounted Nova item for ¥50",
        intent_level: "open",
        constraints: limits("electronics", 5_000),
      },
    });
    expect(greenCheapMandate.structuredContent).toMatchObject({
      status: "pending_checkout",
    });
    const cheapShopCheckout = await checkoutFromShop("NOVA-Q3-BLK");
    expect(cheapShopCheckout.total.amount).toBe(5_000);
    const greenCheapPayment = await client.callTool({
      name: "request_payment",
      arguments: {
        mandate_id: (
          greenCheapMandate.structuredContent as { mandate_id: string }
        ).mandate_id,
        payment_request: cheapShopCheckout.payment_request,
        price_evidence: [],
        rationale: "Buy the discounted Nova item",
      },
    });
    expect(greenCheapPayment.structuredContent).toMatchObject({
      status: "paid",
      receipt: { amount: { amount: 5_000, currency: "CNY" } },
    });
    expect(greenCheapPayment.structuredContent).not.toHaveProperty(
      "approval_id",
    );
    expect(
      (greenCheapPayment.structuredContent as { message: string }).message,
    ).toContain("No owner approval is pending");
    const afterAuto = await gateway.inject({
      method: "GET",
      url: "/v1/app/approvals?status=pending",
      headers: { authorization: "Bearer test-app" },
    });
    expect(afterAuto.json().items).toEqual([]);

    await setShopPrice(14_500);
    const greenHighMandate = await client.callTool({
      name: "create_mandate",
      arguments: {
        description: "Buy a Nova item for ¥150",
        user_text: "Buy a Nova item for ¥150",
        intent_level: "open",
        constraints: limits("electronics", 15_000),
      },
    });
    const highShopCheckout = await checkoutFromShop("NOVA-Q3-BLK");
    expect(highShopCheckout.total.amount).toBe(15_000);
    const greenHighPayment = await client.callTool({
      name: "request_payment",
      arguments: {
        mandate_id: (
          greenHighMandate.structuredContent as { mandate_id: string }
        ).mandate_id,
        payment_request: highShopCheckout.payment_request,
        price_evidence: [],
        rationale: "Buy the Nova item",
      },
    });
    expect(greenHighPayment.structuredContent).toMatchObject({
      status: "awaiting_user",
      payment_id: expect.stringMatching(/^pay_/),
      approval_id: expect.stringMatching(/^apr_/),
    });
    const afterHigh = await gateway.inject({
      method: "GET",
      url: "/v1/app/approvals?status=pending",
      headers: { authorization: "Bearer test-app" },
    });
    expect(afterHigh.json().items).toHaveLength(1);
    expect(afterHigh.json().items[0].approval_id).toBe(
      (greenHighPayment.structuredContent as { approval_id: string })
        .approval_id,
    );
    const temporaryDrill = await gateway.inject({
      method: "POST",
      url: "/v1/app/demo/drills/start",
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "temporary-shop-decoy-visibility",
      },
      payload: {},
    });
    expect(temporaryDrill.statusCode).toBe(200);
    const earlierDecoyCheckout = await checkoutFromShop("REWARD-GIFT-500");
    const stoppedDrill = await gateway.inject({
      method: "POST",
      url: "/v1/app/demo/drills/stop",
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "stop-temporary-shop-decoy-visibility",
      },
      payload: {},
    });
    expect(stoppedDrill.statusCode).toBe(200);
    expect(drillVisible).toBe(false);
    const ordinaryDecoyMandate = await client.callTool({
      name: "create_mandate",
      arguments: {
        description: "Buy a reward voucher",
        user_text: "Buy a reward voucher",
        intent_level: "open",
        constraints: limits("electronics", 5_000),
      },
    });
    const ordinaryDecoy = await client.callTool({
      name: "request_payment",
      arguments: {
        mandate_id: (
          ordinaryDecoyMandate.structuredContent as { mandate_id: string }
        ).mandate_id,
        payment_request: earlierDecoyCheckout.payment_request,
        price_evidence: [],
        rationale: "Buy reward voucher",
      },
    });
    expect(ordinaryDecoy.structuredContent).toMatchObject({ status: "denied" });
    const beforeDrill = await client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    expect(beforeDrill.structuredContent).toMatchObject({
      licence: { drills_failed: 0 },
    });
    expect(
      (beforeDrill.structuredContent as { licence: { level: string } }).licence
        .level,
    ).not.toBe("RED");

    const startDrill = await gateway.inject({
      method: "POST",
      url: "/v1/app/demo/drills/start",
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "start-connected-fire-drill",
      },
      payload: {},
    });
    expect(startDrill.statusCode).toBe(200);
    expect(drillVisible).toBe(true);
    const decoyMandate = await client.callTool({
      name: "create_mandate",
      arguments: {
        description: "Buy a reward voucher",
        user_text: "Buy a reward voucher",
        intent_level: "open",
        constraints: limits("electronics", 5_000),
      },
    });
    const activeDecoyCheckout = await checkoutFromShop("REWARD-GIFT-500");
    const decoyAttempt = await client.callTool({
      name: "request_payment",
      arguments: {
        mandate_id: (decoyMandate.structuredContent as { mandate_id: string })
          .mandate_id,
        payment_request: activeDecoyCheckout.payment_request,
        price_evidence: [],
        rationale: "Buy reward voucher",
      },
    });
    expect(decoyAttempt.structuredContent).toMatchObject({ status: "denied" });
    const redStatus = await client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    expect(redStatus.structuredContent).toMatchObject({
      state: "red",
      licence: { level: "RED", drills_failed: 1 },
    });
    expect(
      (redStatus.structuredContent as { message: string }).message,
    ).toContain("Return to Amber");
    const redSpend = await client.callTool({
      name: "request_payment",
      arguments: {
        mandate_id: (decoyMandate.structuredContent as { mandate_id: string })
          .mandate_id,
        payment_request: signedUri("CNY", "red-block", 5_000, "ord_red_block"),
        price_evidence: [],
        rationale: "Try to spend while Red",
      },
    });
    expect(redSpend.isError).toBe(true);
    expect(JSON.stringify(redSpend.content)).toContain("Return to Amber");

    const retiredCards = await gateway.inject({
      method: "GET",
      url: "/v1/app/approvals?status=pending",
      headers: { authorization: "Bearer test-app" },
    });
    expect(retiredCards.json().items).toEqual([]);
    const agentTrustAttempt = await gateway.inject({
      method: "POST",
      url: `/v1/app/agents/${agent.agent_id}/prepare-return-to-amber`,
      headers: { authorization: "Bearer test-agent" },
      payload: {},
    });
    expect(agentTrustAttempt.statusCode).toBe(401);
    const returnPrepare = await gateway.inject({
      method: "POST",
      url: `/v1/app/agents/${agent.agent_id}/prepare-return-to-amber`,
      headers: { authorization: "Bearer test-app" },
      payload: {},
    });
    expect(returnPrepare.statusCode).toBe(200);
    const returned = await gateway.inject({
      method: "POST",
      url: `/v1/app/agents/${agent.agent_id}/return-to-amber`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "return-red-agent-to-amber",
      },
      payload: {
        challenge_id: returnPrepare.json().challenge_id,
        verification: {
          action_hash: returnPrepare.json().action_hash,
          device_signature: "test-biometric-proof",
        },
      },
    });
    expect(returned.statusCode).toBe(200);
    expect(returned.json().agent.licence.level).toBe("AMBER");
    const oldCardApproval = await gateway.inject({
      method: "POST",
      url: `/v1/app/approvals/${afterHigh.json().items[0].approval_id}/decide`,
      headers: {
        authorization: "Bearer test-app",
        "idempotency-key": "old-green-card-after-return",
      },
      payload: {
        decision: "approve",
        verification: {
          action_hash: afterHigh.json().items[0].payload_hash,
          device_signature: "test-biometric-proof",
        },
      },
    });
    expect(oldCardApproval.statusCode).toBe(403);
    const amberAgain = await client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    expect(amberAgain.structuredContent).toMatchObject({
      state: "connected",
      licence: { level: "AMBER", drills_failed: 1 },
    });
  });
});
