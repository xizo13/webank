import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Agent, Policy } from "@webank/contracts";
import { expect, it } from "vitest";
import { createGateway } from "../../../services/gateway/src/app.js";
import { WeBankConnector } from "../src/client.js";
import { createConnectorServer } from "../src/index.js";
import { newAgentKey } from "../src/signing.js";
import {
  type Credentials,
  clientAppIdentity,
  FileCredentialStore,
} from "../src/storage.js";

it("hashes the exact UTF-8 MCP app name and rejects invalid identities", () => {
  const name = "Claude Code ✨";
  expect(clientAppIdentity(name)).toEqual({
    id: `app_${createHash("sha256").update(name, "utf8").digest("hex")}`,
    name,
  });
  expect(clientAppIdentity("App Alpha").id).not.toBe(
    clientAppIdentity("app alpha").id,
  );
  expect(clientAppIdentity("😀".repeat(64)).name).toBe("😀".repeat(64));
  for (const invalid of [
    undefined,
    "",
    "   ",
    "bad\nname",
    "\ud800",
    "a".repeat(257),
    "😀".repeat(65),
  ]) {
    expect(() => clientAppIdentity(invalid)).toThrow();
  }
});

it("rejects missing MCP app identity before reading credentials", async () => {
  let reads = 0;
  const store = {
    load: async () => {
      reads++;
      return null;
    },
    save: async () => {},
  };
  const connector = new WeBankConnector(
    new URL("http://127.0.0.1:8787"),
    store,
    async () => {
      throw new Error("Gateway must not be contacted");
    },
  );
  const server = createConnectorServer(connector);
  const client = new Client({ name: "", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContainEqual({
      type: "text",
      text: "Valid MCP initialize clientInfo.name is required",
    });
    expect(reads).toBe(0);
  } finally {
    await client.close();
    await server.close();
  }
});

it("keeps one agent per MCP app while sharing it across chats in that app", async () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const directory = await mkdtemp(join(tmpdir(), "webank-app-identity-"));
  const basePath = join(directory, "connector.json");
  const alphaApp = clientAppIdentity("App Alpha");
  const betaApp = clientAppIdentity("App Beta ");
  const key = newAgentKey();
  const agent: Agent = {
    schema: "agent.v1",
    agent_id: "agt_first_app",
    user_id: "usr_test",
    display_name: "First app",
    provider: "Anthropic",
    client_app_id: alphaApp.id,
    client_app_name: alphaApp.name,
    public_key: key.publicKey,
    scopes: ["wallet:pay", "wallet:mandate", "wallet:history:self"],
    licence: { level: "L", points: 0, clean_purchases: 0, drills_passed: 0 },
    status: "active",
    created_at: now.toISOString(),
    last_used_at: now.toISOString(),
  };
  const policy: Policy = {
    schema: "policy.v1",
    user_id: "usr_test",
    per_payment_max: { amount: 30000, currency: "CNY" },
    daily_max: { amount: 50000, currency: "CNY" },
    monthly_max: { amount: 100000, currency: "CNY" },
    auto_approve_below: { amount: 0, currency: "CNY" },
    blocked_categories: [],
    new_merchant_requires_tap: false,
    treasurer: {
      enabled: false,
      buffer_target: { amount: 0, currency: "CNY" },
      daily_topup_ceiling: { amount: 0, currency: "CNY" },
      monthly_topup_ceiling: { amount: 0, currency: "CNY" },
      protected_main_balance: { amount: 0, currency: "CNY" },
    },
  };
  const gateway = createGateway(
    {
      authenticateAgent: async (request) =>
        request.headers.authorization === "Bearer test-agent" ? agent : null,
      lookupMerchant: async () => null,
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
      preflightPayment: async () => {},
      executePayment: async () => `0x${"1".repeat(64)}`,
      anchorAudit: async () => `0x${"2".repeat(64)}`,
      signReceipt: async () => "signature",
      now: () => now,
    },
    { agents: [agent], policies: [policy] },
  );
  const credentials: Credentials = {
    ...key,
    agentId: agent.agent_id,
    accessToken: "test-agent",
    tokenExpiresAt: now.getTime() + 900000,
  };
  await writeFile(basePath, JSON.stringify(credentials), { mode: 0o600 });
  await new FileCredentialStore(basePath).forApp(alphaApp).save(credentials);
  let betaPairing: Record<string, unknown> | null = null;
  const gatewayFetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (
      url.pathname === "/v1/oauth/device_authorization" &&
      init.method === "POST"
    ) {
      betaPairing = JSON.parse(String(init.body));
    }
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
  };
  const pairs = await Promise.all(
    ["App Alpha", "App Beta ", "App Alpha"].map(async (name, index) => {
      const connector = new WeBankConnector(
        new URL("http://127.0.0.1:8787"),
        new FileCredentialStore(basePath),
        gatewayFetch,
        async () => {},
        () => now.getTime(),
      );
      const server = createConnectorServer(connector);
      const client = new Client({
        name,
        version: index === 2 ? "2.0.0" : "1.0.0",
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, server };
    }),
  );
  try {
    const [alpha, beta, alphaNewChat] = pairs;
    const first = await alpha.client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    const second = await beta.client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    const sameApp = await alphaNewChat.client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    expect(first.structuredContent).toMatchObject({
      state: "connected",
      agent_id: agent.agent_id,
    });
    expect(second.structuredContent).toMatchObject({ state: "not_paired" });
    expect(sameApp.structuredContent).toMatchObject({
      state: "connected",
      agent_id: agent.agent_id,
    });
    const cannotAct = await beta.client.callTool({
      name: "create_mandate",
      arguments: {
        description: "Buy headphones",
        user_text: "Buy headphones",
        intent_level: "open",
        constraints: [
          { type: "amount_range", max: { amount: 30000, currency: "CNY" } },
          { type: "categories", allowed: ["electronics"] },
          { type: "budget", max: { amount: 30000, currency: "CNY" } },
          { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
          {
            type: "execution_window",
            not_before: null,
            not_after: "2026-10-20T00:00:00Z",
          },
        ],
      },
    });
    expect(cannotAct.isError).toBe(true);
    const acted = await alphaNewChat.client.callTool({
      name: "create_mandate",
      arguments: {
        description: "Buy headphones",
        user_text: "Buy headphones",
        intent_level: "open",
        constraints: [
          { type: "amount_range", max: { amount: 30000, currency: "CNY" } },
          { type: "categories", allowed: ["electronics"] },
          { type: "budget", max: { amount: 30000, currency: "CNY" } },
          { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
          {
            type: "execution_window",
            not_before: null,
            not_after: "2026-10-20T00:00:00Z",
          },
        ],
      },
    });
    expect(acted.isError).not.toBe(true);
    expect(acted.structuredContent).toMatchObject({
      status: "pending_checkout",
    });
    const mandateId = (acted.structuredContent as { mandate_id: string })
      .mandate_id;
    const seenByFirst = await alpha.client.callTool({
      name: "get_mandate_status",
      arguments: { mandate_id: mandateId },
    });
    expect(seenByFirst.structuredContent).toMatchObject({
      mandate_id: mandateId,
      status: "pending_checkout",
    });
    const firstPairing = await beta.client.callTool({
      name: "connect_webank",
      arguments: {},
    });
    expect(firstPairing.structuredContent).toMatchObject({
      status: "awaiting_user",
    });
    const rePairing = await beta.client.callTool({
      name: "connect_webank",
      arguments: { re_pair: true },
    });
    expect(rePairing.structuredContent).toMatchObject({
      status: "awaiting_user",
    });
    const spoofed = await beta.client.callTool({
      name: "connect_webank",
      arguments: { client_name: "App Alpha", provider: "Anthropic" },
    });
    expect(spoofed.structuredContent).toMatchObject({
      status: "awaiting_user",
    });
    expect(betaPairing).toMatchObject({
      client_name: betaApp.name,
      client_app_id: betaApp.id,
      client_app_name: betaApp.name,
    });
    expect((await stat(basePath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "apps"))).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(directory, "apps", `${alphaApp.id}.json`))).mode & 0o777,
    ).toBe(0o600);
    expect(
      (await stat(join(directory, "apps", `${betaApp.id}.json`))).mode & 0o777,
    ).toBe(0o600);
    expect(JSON.parse(await readFile(basePath, "utf8")).agentId).toBe(
      agent.agent_id,
    );
    expect(
      (await new FileCredentialStore(basePath).forApp(alphaApp).load())
        ?.agentId,
    ).toBe(agent.agent_id);
    expect(
      (await new FileCredentialStore(basePath).forApp(betaApp).load())?.agentId,
    ).toBeUndefined();
  } finally {
    await Promise.all(
      pairs.map(async ({ client, server }) => {
        await client.close();
        await server.close();
      }),
    );
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});
