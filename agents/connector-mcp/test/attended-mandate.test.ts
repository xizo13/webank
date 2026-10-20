import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { WeBankConnector } from "../src/client.js";
import { createConnectorServer } from "../src/index.js";
import { newAgentKey } from "../src/signing.js";
import type { CredentialStore, Credentials } from "../src/storage.js";

it("takes an attended mandate from pending checkout to a payment approval", async () => {
  const key = newAgentKey();
  let credentials: Credentials = {
    ...key,
    agentId: "agt_attended",
    accessToken: "test-access-token",
    tokenExpiresAt: Date.now() + 900_000,
  };
  const store: CredentialStore = {
    load: async () => credentials,
    save: async (value) => {
      credentials = value;
    },
  };
  const mandate = {
    schema: "mandate.v1",
    mandate_id: "mdt_attended",
    agent_id: "agt_attended",
    agent_key_binding: key.publicKey,
    description: "Buy headphones",
    intent_level: "open",
    approval_timing: "payment",
    user_text: "Buy headphones",
    user_text_source: "agent_reported",
    constraints: [
      { type: "amount_range", max: { amount: 30_000, currency: "CNY" } },
      { type: "categories", allowed: ["electronics"] },
      { type: "budget", max: { amount: 30_000, currency: "CNY" } },
      { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
      {
        type: "execution_window",
        not_before: null,
        not_after: "2026-10-20T00:00:00Z",
      },
    ],
    status: "pending_checkout",
    spent: { amount: 0, currency: "CNY" },
    occurrences: 0,
    in_flight_payment_id: null,
    approved_by: null,
    created_at: "2026-10-19T00:00:00Z",
  };
  const seen: string[] = [];
  const notifications: string[] = [];
  const gatewayFetch: typeof fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    const method = init.method || "GET";
    seen.push(`${method} ${path}`);
    const reply = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (path === "/v1/agent/mandates" && method === "POST") {
      expect(JSON.parse(String(init.body)).approval_timing).toBe("payment");
      return reply(201, { mandate });
    }
    if (path === "/v1/agent/mandates/mdt_attended" && method === "GET")
      return reply(200, { mandate });
    if (path === "/v1/agent/payments" && method === "POST") {
      expect(JSON.parse(String(init.body)).mandate_id).toBe("mdt_attended");
      return reply(202, {
        payment_id: "pay_attended",
        status: "awaiting_user",
        decision: {
          schema: "decision.v1",
          decision_id: "dec_attended",
          payment_id: "pay_attended",
          outcome: "STEP_UP",
          autonomy_level: "L0",
          checks: [],
          risk_signals: [],
          user_explanation: "Review this purchase in WeBank.",
          created_at: "2026-10-19T00:00:00Z",
        },
        approval_id: "apr_attended",
        level: "zero_trust",
        expires_at: "2026-10-19T00:03:00Z",
        poll_after: 3,
        approval_level: "zero_trust",
        request_number: "123456",
      });
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const connector = new WeBankConnector(
    new URL("http://127.0.0.1:8787"),
    store,
    gatewayFetch,
    async (_title, body) => {
      notifications.push(body);
    },
  );
  const server = createConnectorServer(connector);
  const client = new Client({ name: "attended-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(client.getInstructions()).toContain("pending_checkout");
    expect(client.getInstructions()).toContain(
      "If it returns pending_user, wait for approval and confirm active before shopping; if it returns active, shopping may begin",
    );
    expect(
      tools.tools.find((tool) => tool.name === "create_mandate")?.description,
    ).toContain("approval_timing:upfront");

    const created = await client.callTool({
      name: "create_mandate",
      arguments: {
        description: "Buy headphones",
        user_text: "Buy headphones",
        intent_level: "open",
        approval_timing: "payment",
        constraints: mandate.constraints,
      },
    });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({
      status: "pending_checkout",
      mandate_id: "mdt_attended",
      approval_timing: "payment",
    });
    expect(created.structuredContent).not.toHaveProperty("approval_id");
    expect(created.structuredContent).not.toHaveProperty("request_number");
    expect(JSON.stringify(created.structuredContent)).toContain(
      "No approval or payment exists yet",
    );
    expect(notifications).toEqual([]);

    const checked = await client.callTool({
      name: "get_mandate_status",
      arguments: { mandate_id: "mdt_attended" },
    });
    expect(checked.structuredContent).toMatchObject({
      status: "pending_checkout",
      approval_timing: "payment",
    });

    const payment = await client.callTool({
      name: "request_payment",
      arguments: {
        mandate_id: "mdt_attended",
        payment_request: "ecny://pay?d=attended-fixture",
        price_evidence: [],
        rationale: "User asked for headphones",
      },
    });
    expect(payment.isError).not.toBe(true);
    expect(payment.structuredContent).toMatchObject({
      status: "awaiting_user",
      payment_id: "pay_attended",
      approval_id: "apr_attended",
      message:
        "WeBank created a payment approval for the user. The payment has not been settled.",
    });
    expect(notifications).toEqual(["Request number 123456"]);
    expect(seen).toEqual([
      "POST /v1/agent/mandates",
      "GET /v1/agent/mandates/mdt_attended",
      "POST /v1/agent/payments",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
