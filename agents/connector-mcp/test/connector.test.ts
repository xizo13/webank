import { createHash, createPublicKey, verify } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { WeBankConnector } from "../src/client.js";
import { createConnectorServer } from "../src/index.js";
import type { CredentialStore, Credentials } from "../src/storage.js";

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

  it("pairs, calls all five tools, signs each request, and rejects replay", async () => {
    const store = new MemoryStore();
    const notifications: string[] = [];
    const nonces = new Set<string>();
    const paths: string[] = [];
    let approved = false;
    let publicKey = "";
    let replay: { url: URL; init: RequestInit } | undefined;

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
      if (url.pathname === "/v1/oauth/token") {
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

      if (url.pathname === "/v1/agent/mandates") {
        return reply(202, {
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
          approval_id: "apr_mandate",
        });
      }
      if (url.pathname === "/v1/agent/payments" && init.method === "POST") {
        return reply(202, {
          payment_id: "pay_test",
          status: "awaiting_user",
          decision,
          approval_id: "apr_payment",
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
      "create_mandate",
      "request_payment",
      "get_payment_status",
      "list_my_payments",
    ]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return result.structuredContent as Record<string, unknown>;
    };

    const pairing = await call("connect_webank", {});
    expect(pairing.status).toBe("awaiting_user");
    expect(pairing.request_number).toBe("123456");
    expect(JSON.stringify(pairing)).not.toContain("secret-device-code");
    expect(notifications).toContain("Request number 123456");
    approved = true;
    const connected = await call("connect_webank", {});
    expect(connected).toEqual({ status: "connected", agent_id: "agt_test" });

    const mandate = await call("create_mandate", {
      description: "Buy headphones",
      constraints,
    });
    expect(mandate.status).toBe("pending_user");
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
    expect((await call("list_my_payments", { limit: 10 })).items).toHaveLength(
      1,
    );
    expect(
      paths.filter((path) => path.startsWith("GET /v1/agent/")),
    ).toHaveLength(2);
    expect(store.value?.privateKeyPem).toContain("PRIVATE KEY");
    expect(
      JSON.stringify({ pairing, connected, mandate, payment }),
    ).not.toContain("secret-access-token");
    if (!replay) throw new Error("No signed request captured for replay");
    const replayed = await gatewayFetch(replay.url, replay.init);
    expect(replayed.status).toBe(401);
  });
});
