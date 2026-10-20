import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Agent } from "@webank/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../../../services/gateway/src/app.js";
import { WeBankConnector } from "../src/client.js";
import { createConnectorServer } from "../src/index.js";
import { newAgentKey, signAgentRequest } from "../src/signing.js";
import {
  type CredentialStore,
  type Credentials,
  clientAppIdentity,
} from "../src/storage.js";

class MemoryStore implements CredentialStore {
  value: Credentials | null = null;
  async load() {
    return this.value;
  }
  async save(value: Credentials) {
    this.value = structuredClone(value);
  }
}

const constraints = [
  { type: "amount_range", max: { amount: 30000, currency: "CNY" } },
  { type: "categories", allowed: ["electronics"] },
  { type: "budget", max: { amount: 30000, currency: "CNY" } },
  { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
  {
    type: "execution_window",
    not_before: null,
    not_after: "2026-10-15T00:00:00Z",
  },
];

const decision = {
  schema: "decision.v1",
  decision_id: "dec_test",
  payment_id: "pay_test",
  outcome: "STEP_UP",
  autonomy_level: "L1",
  checks: [],
  risk_signals: [],
  user_explanation: "Approve this verified purchase in the WeBank app.",
  created_at: "2026-10-14T00:00:00Z",
};

describe("WeBank MCP connector", () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of open.splice(0)) await close();
  });

  it("pairs, calls all six tools, signs each request, and rejects replay", async () => {
    const store = new MemoryStore();
    const notifications: string[] = [];
    const nonces = new Set<string>();
    const paths: string[] = [];
    let approved = false;
    let publicKey = "";
    let replay: { url: URL; init: RequestInit } | undefined;
    let refreshed = 0;
    let currentNumber = "123456";
    const pairingStatuses: string[] = [];

    const gatewayFetch = async (
      input: URL | RequestInfo,
      init: RequestInit = {},
    ) => {
      const url = new URL(String(input));
      const headers = new Headers(init.headers);
      const body = typeof init.body === "string" ? init.body : "";
      const reply = (status: number, value: unknown) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        });
      paths.push(`${init.method} ${url.pathname}`);
      if (url.pathname === "/v1/oauth/device_authorization") {
        const data = JSON.parse(body);
        expect(data.provider).toBe("Anthropic");
        expect(data.requested_scopes).toEqual([
          "wallet:pay",
          "wallet:mandate",
          "wallet:history:self",
        ]);
        publicKey = data.agent_public_key;
        return reply(200, {
          device_code: "secret-device-code",
          user_code: "WQ7K-3MXP",
          verification_uri: "https://webank.example/pair",
          qr_payload: "https://webank.example/pair?code=WQ7K-3MXP",
          request_number: "123456",
          expires_in: 600,
          interval: 3,
        });
      }
      if (
        url.pathname === "/v1/oauth/device_authorization/secret-device-code"
      ) {
        return reply(200, {
          status: pairingStatuses.shift() ?? "pending",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          request_number: currentNumber,
          request_number_expires_at: new Date(
            Date.now() + 180_000,
          ).toISOString(),
        });
      }
      if (url.pathname === "/v1/oauth/token") {
        if (JSON.parse(body).grant_type === "refresh_token") {
          refreshed++;
          return reply(200, {
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 900,
            agent_id: "agt_test",
          });
        }
        if (!approved) return reply(400, { error: "authorization_pending" });
        return reply(200, {
          access_token: "secret-access-token",
          refresh_token: "secret-refresh-token",
          expires_in: 900,
          agent_id: "agt_test",
        });
      }

      expect(headers.get("authorization")).toBe("Bearer secret-access-token");
      const signatureInput = headers.get("signature-input") ?? "";
      const signature = headers.get("signature") ?? "";
      const nonce = /;nonce="([^"]+)"/.exec(signatureInput)?.[1];
      if (!nonce || nonces.has(nonce))
        return reply(401, { error: { code: "bad_signature" } });
      nonces.add(nonce);
      expect(signatureInput).toMatch(
        /;expires=\d+;nonce="[^"]+";keyid="agt_test";alg="ecdsa-p256-sha256"$/,
      );
      const params = signatureInput.slice("sig1=".length);
      const digest = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
      expect(headers.get("content-digest")).toBe(digest);
      const base = [
        `"@method": ${init.method}`,
        `"@path": ${url.pathname}`,
        `"content-digest": ${digest}`,
        `"idempotency-key": ${headers.get("idempotency-key")}`,
        `"@signature-params": ${params}`,
      ].join("\n");
      const rawSignature = /^sig1=:([^:]+):$/.exec(signature)?.[1] ?? "";
      const key = createPublicKey({
        key: Buffer.from(publicKey.slice(5), "base64url"),
        format: "der",
        type: "spki",
      });
      expect(
        verify(
          "sha256",
          Buffer.from(base),
          key,
          Buffer.from(rawSignature, "base64"),
        ),
      ).toBe(true);
      replay = { url, init };

      if (url.pathname === "/v1/agent/session") {
        return reply(200, {
          state: "connected",
          agent_id: "agt_test",
          client_app_id: clientAppIdentity("connector-test").id,
          client_app_name: "connector-test",
          access_token_valid: false,
          licence: {
            level: "L",
            points: 0,
            clean_purchases: 0,
            drills_passed: 0,
          },
          active_mandates: [],
        });
      }

      if (url.pathname === "/v1/agent/mandates") {
        return reply(202, {
          mandate: {
            schema: "mandate.v1",
            mandate_id: "mdt_test",
            agent_id: "agt_test",
            agent_key_binding: publicKey,
            description: "Buy headphones",
            intent_level: "open",
            approval_timing: "upfront",
            user_text: "Buy headphones",
            user_text_source: "agent_reported",
            constraints,
            status: "pending_user",
            spent: { amount: 0, currency: "CNY" },
            occurrences: 0,
            in_flight_payment_id: null,
            approved_by: null,
            created_at: "2026-10-14T00:00:00Z",
          },
          approval_id: "apr_mandate",
          level: "zero_trust",
          expires_at: "2026-10-14T00:03:00Z",
          request_number: "345678",
        });
      }
      if (url.pathname === "/v1/agent/mandates/mdt_test") {
        return reply(200, {
          mandate: {
            schema: "mandate.v1",
            mandate_id: "mdt_test",
            agent_id: "agt_test",
            agent_key_binding: publicKey,
            description: "Buy headphones",
            intent_level: "open",
            user_text: "Buy headphones",
            user_text_source: "agent_reported",
            constraints,
            status: "pending_user",
            spent: { amount: 0, currency: "CNY" },
            occurrences: 0,
            in_flight_payment_id: null,
            approved_by: null,
            created_at: "2026-10-14T00:00:00Z",
          },
        });
      }
      if (url.pathname === "/v1/agent/payments" && init.method === "POST") {
        return reply(202, {
          payment_id: "pay_test",
          status: "awaiting_user",
          decision,
          approval_id: "apr_payment",
          level: "zero_trust",
          expires_at: "2026-10-14T00:03:00Z",
          poll_after: 3,
          approval_level: "zero_trust",
          request_number: "654321",
        });
      }
      if (url.pathname === "/v1/agent/payments/pay_test") {
        return reply(200, {
          payment_id: "pay_test",
          status: "awaiting_user",
          decision,
        });
      }
      if (url.pathname === "/v1/agent/payments") {
        return reply(200, {
          items: [
            {
              payment_id: "pay_test",
              status: "awaiting_user",
              amount: { amount: 27900, currency: "CNY" },
              merchant: "Shop A Electronics",
              created_at: "2026-10-14T00:00:00Z",
            },
          ],
          next_cursor: null,
        });
      }
      return reply(404, { error: { code: "not_found" } });
    };

    const connector = new WeBankConnector(
      new URL("http://127.0.0.1:8787"),
      store,
      gatewayFetch as typeof fetch,
      async (_title, message) => {
        notifications.push(message);
      },
    );
    const server = createConnectorServer(connector);
    const client = new Client({ name: "connector-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    open.push(async () => {
      await client.close();
      await server.close();
    });

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "connect_webank",
      "get_wallet_status",
      "wait_for_approval",
      "disconnect_webank",
      "create_mandate",
      "get_mandate_status",
      "request_payment",
      "get_payment_status",
      "list_my_payments",
    ]);
    expect(client.getInstructions()).toContain(
      "A shop checkout payment_request is only merchant-signed",
    );
    expect(client.getInstructions()).toContain(
      "only after WeBank request_payment returns status awaiting_user with both payment_id and approval_id",
    );
    expect(client.getInstructions()).toContain(
      "mandate_id and no payment_id means only the upfront mandate awaits approval",
    );
    expect(client.getInstructions()).toContain(
      "The licence light is AMBER, GREEN, or RED",
    );
    expect(client.getInstructions()).toContain(
      "RED cannot spend until the owner reviews its history and uses Return to Amber",
    );
    expect(client.getInstructions()).toContain(
      "A paid response means WeBank settled it and includes a receipt",
    );
    expect(
      tools.tools.find((tool) => tool.name === "request_payment")?.description,
    ).toContain(
      "Tell the user a payment approval is pending only if this tool returns status awaiting_user with both payment_id and approval_id",
    );
    expect(
      tools.tools.find((tool) => tool.name === "request_payment")?.description,
    ).toContain("GREEN may return paid with a receipt automatically");
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return result.structuredContent as Record<string, unknown>;
    };

    const pairing = await call("connect_webank", {});
    expect(pairing.status).toBe("awaiting_user");
    expect(pairing.request_number).toBe("123456");
    expect(JSON.stringify(pairing)).not.toContain("secret-device-code");
    expect(notifications).toEqual(["Request number 123456"]);
    currentNumber = "777777";
    const rotated = await call("connect_webank", {});
    expect(rotated.status).toBe("awaiting_user");
    expect(rotated.user_code).toBe(pairing.user_code);
    expect(rotated.request_number).toBe("777777");
    expect(notifications).toEqual([
      "Request number 123456",
      "Request number 777777",
    ]);
    expect(rotated.notification_delivered).toBe(true);
    expect((await store.load())?.pending?.requestNumber).toBe("777777");
    expect((await store.load())?.publicKey).toBe(publicKey);
    pairingStatuses.push("pending", "expired");
    const expiredAtEnd = await call("connect_webank", {});
    expect(expiredAtEnd.status).toBe("pairing_expired");
    expect(expiredAtEnd).not.toHaveProperty("request_number");
    expect((await store.load())?.pending).toBeUndefined();
    expect(notifications).toHaveLength(3);
    pairingStatuses.push("rejected");
    const rejectedAtStart = await call("connect_webank", {});
    expect(rejectedAtStart.status).toBe("not_paired");
    expect(rejectedAtStart).not.toHaveProperty("request_number");
    expect(notifications).toHaveLength(3);
    currentNumber = "123456";
    approved = true;
    const connected = await call("connect_webank", {});
    expect(connected).toEqual({ status: "connected", agent_id: "agt_test" });

    const mandate = await call("create_mandate", {
      description: "Buy headphones",
      user_text: "Buy headphones",
      intent_level: "open",
      approval_timing: "upfront",
      constraints,
    });
    expect(mandate.status).toBe("pending_user");
    expect(mandate.level).toBe("zero_trust");
    expect(mandate.request_number).toBe("345678");
    expect(notifications).toContain("Request number 345678");
    expect(
      await call("get_mandate_status", { mandate_id: "mdt_test" }),
    ).toMatchObject({ status: "pending_user", approval_timing: "upfront" });
    const pathsBeforeBadInput = paths.length;
    const loose = await client.callTool({
      name: "create_mandate",
      arguments: {
        description: "Buy headphones",
        user_text: "Buy headphones",
        intent_level: "open",
        constraints: [
          { type: "amount_range", max: { amount: 279.5, currency: "CNY" } },
        ],
      },
    });
    expect(loose.isError).toBe(true);
    expect(paths).toHaveLength(pathsBeforeBadInput);
    const payment = await call("request_payment", {
      mandate_id: "mdt_test",
      payment_request: "ecny://pay?d=abc",
      price_evidence: [],
      rationale: "User asked for headphones",
    });
    expect(payment.status).toBe("awaiting_user");
    expect(payment.request_number).toBe("654321");
    expect(notifications).toContain("Request number 654321");
    expect(
      (await call("get_payment_status", { payment_id: "pay_test" })).status,
    ).toBe("awaiting_user");
    const history = await call("list_my_payments", { limit: 10 });
    expect(history.items).toHaveLength(1);
    expect((history.items as Array<{ amount: unknown }>)[0].amount).toEqual({
      amount: 27900,
      currency: "CNY",
      display: "¥279.00",
    });
    expect(
      paths.filter((path) => path.startsWith("GET /v1/agent/")),
    ).toHaveLength(3);
    expect(store.value?.privateKeyPem).toContain("PRIVATE KEY");
    expect(
      JSON.stringify({ pairing, connected, mandate, payment }),
    ).not.toContain("secret-access-token");
    if (!replay) throw new Error("No signed request captured for replay");
    const replayed = await gatewayFetch(replay.url, replay.init);
    expect(replayed.status).toBe(401);
    const recovered = await call("get_wallet_status", {});
    expect(recovered.state).toBe("connected");
    expect(refreshed).toBe(1);
    expect(store.value?.refreshToken).toBe("new-refresh-token");
  });

  it("keeps a lost credential until explicit re-pair and owner consent", async () => {
    const priorKey = newAgentKey();
    const prior: Agent = {
      schema: "agent.v1",
      agent_id: "agt_prior",
      user_id: "usr_test",
      display_name: "Claude prior",
      provider: "Anthropic",
      public_key: priorKey.publicKey,
      scopes: ["wallet:pay", "wallet:mandate", "wallet:history:self"],
      licence: { level: "L", points: 0, clean_purchases: 0, drills_passed: 0 },
      status: "active",
      created_at: new Date().toISOString(),
      last_used_at: null,
    };
    const gateway = createGateway(
      {
        authenticateApp: async (request) =>
          request.headers.authorization === "Bearer app" ? "usr_test" : null,
        demoApprovalsEnabled: true,
        demoApprovalVerifier: async (approval, proof) =>
          (proof as { action_hash?: string; device_signature?: string })
            .action_hash === approval.payload_hash &&
          (proof as { device_signature?: string }).device_signature ===
            "test-biometric-proof"
            ? "user_biometric"
            : false,
        recordNumberMatchFailure: async () => {},
        lookupMerchant: async () => null,
        reserveMandate: async () => true,
        releaseMandate: async () => {},
        assessRisk: async () => ({
          result: "deny",
          signals: [],
          explanation: "No merchant",
        }),
        evaluateGuardian: async () => ({
          verdict: "deny",
          reasons: [],
          user_explanation: "No merchant",
        }),
        executePayment: async () => {
          throw new Error("unreachable");
        },
        anchorAudit: async () => `0x${"1".repeat(64)}`,
        setTrustLight: async () => `0x${"2".repeat(64)}`,
        signReceipt: async () => "unused",
      },
      { agents: [prior], policies: [] },
    );
    open.push(() => gateway.close());
    const old = {
      ...newAgentKey(),
      agentId: "agt_lost",
      accessToken: "old-token",
    };
    const store = new MemoryStore();
    store.value = old;
    const connector = new WeBankConnector(
      new URL("http://127.0.0.1:8787"),
      store,
      async (input, init = {}) => {
        const url = new URL(String(input));
        const response = await gateway.inject({
          method: (init.method || "GET") as "GET" | "POST",
          url: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(new Headers(init.headers).entries()),
          ...(init.body ? { payload: String(init.body) } : {}),
        });
        return new Response(response.body, { status: response.statusCode });
      },
      async () => {},
    );
    const server = createConnectorServer(connector);
    const client = new Client({ name: "lost-key-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    open.push(async () => {
      await client.close();
      await server.close();
    });
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return result.structuredContent as Record<string, unknown>;
    };
    expect(await call("get_wallet_status")).toMatchObject({
      state: "not_paired",
    });
    expect(await call("connect_webank")).toMatchObject({
      status: "not_paired",
    });
    expect(await call("disconnect_webank")).toMatchObject({
      state: "revocation_required",
    });
    expect(store.value?.privateKeyPem).toBe(old.privateKeyPem);
    const pending = await call("connect_webank", { re_pair: true });
    expect(pending.status).toBe("awaiting_user");
    expect(store.value?.quarantined?.privateKeyPem).toBe(old.privateKeyPem);
    expect(store.value?.privateKeyPem).not.toBe(old.privateKeyPem);
    const claimed = await gateway.inject({
      method: "GET",
      url: `/v1/app/pairing/${pending.user_code}`,
      headers: { authorization: "Bearer app" },
    });
    expect(claimed.statusCode).toBe(200);
    const retiredSelection = await gateway.inject({
      method: "POST",
      url: `/v1/app/pairing/${pending.user_code}/select-replacement`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: { replaces_agent_id: null },
    });
    expect(retiredSelection.statusCode).toBe(410);
    const approved = await gateway.inject({
      method: "POST",
      url: `/v1/app/pairing/${pending.user_code}/approve`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {
        verification: {
          action_hash: claimed.json().approval.payload_hash,
          device_signature: "test-biometric-proof",
          request_number: pending.request_number,
        },
      },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().agent.lineage).toMatchObject({
      root_agent_id: approved.json().agent.agent_id,
      replaces_agent_id: null,
    });
    const oldSession = await gateway.inject({
      method: "GET",
      url: "/v1/agent/session",
      headers: signAgentRequest({
        method: "GET",
        path: "/v1/agent/session",
        body: "",
        idempotencyKey: randomUUID(),
        agentId: prior.agent_id,
        privateKeyPem: priorKey.privateKeyPem,
      }),
    });
    expect(oldSession.json().state).toBe("connected");
    expect(await call("connect_webank")).toMatchObject({ status: "connected" });
    expect(store.value?.quarantined).toBeUndefined();
  });
});
