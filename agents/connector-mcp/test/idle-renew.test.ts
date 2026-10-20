import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { WeBankConnector } from "../src/client.js";
import { createConnectorServer } from "../src/index.js";
import { newAgentKey } from "../src/signing.js";
import {
  type CredentialStore,
  type Credentials,
  clientAppIdentity,
} from "../src/storage.js";

it("keeps an idle app blocked until owner reapproval enables same-key signed renewal", async () => {
  const now = new Date("2026-10-19T12:00:00Z");
  const app = clientAppIdentity("Idle App");
  const key = newAgentKey();
  let credentials: Credentials = {
    ...key,
    agentId: "agt_idle",
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    tokenExpiresAt: now.getTime() + 900_000,
  };
  const store: CredentialStore = {
    load: async () => credentials,
    save: async (value) => {
      credentials = structuredClone(value);
    },
  };
  let ownerReapproved = false;
  let renewed = false;
  let renewAttempts = 0;
  const requests: string[] = [];
  const gatewayFetch: typeof fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    const method = init.method ?? "GET";
    requests.push(`${method} ${path}`);
    const headers = new Headers(init.headers);
    const reply = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (path === "/v1/agent/session") {
      expect(headers.get("signature-input")).toContain('keyid="agt_idle"');
      return reply(200, {
        state: renewed ? "connected" : "reauthorization_required",
        agent_id: "agt_idle",
        client_app_id: app.id,
        client_app_name: app.name,
        last_used_at: "2026-10-11T12:00:00Z",
        idle_expires_at: "2026-10-18T12:00:00Z",
        access_token_valid: renewed,
        licence: {
          level: "L",
          points: 0,
          clean_purchases: 0,
          drills_passed: 0,
        },
        active_mandates: [],
      });
    }
    if (path === "/v1/agent/session/renew" && method === "POST") {
      renewAttempts++;
      expect(init.body).toBe("{}");
      expect(headers.get("signature-input")).toContain('keyid="agt_idle"');
      expect(headers.get("authorization")).toBeNull();
      if (!ownerReapproved)
        return reply(409, { error: { code: "action_changed" } });
      renewed = true;
      return reply(200, {
        access_token: "renewed-access-token",
        refresh_token: "renewed-refresh-token",
        expires_in: 900,
        agent_id: "agt_idle",
      });
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  };
  const connector = new WeBankConnector(
    new URL("http://127.0.0.1:8787"),
    store,
    gatewayFetch,
    async () => {},
    () => now.getTime(),
  );
  const server = createConnectorServer(connector);
  const client = new Client({ name: app.name, version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const before = await client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    expect(before.structuredContent).toMatchObject({
      state: "reauthorization_required",
      client_app_id: app.id,
    });
    expect(JSON.stringify(before.structuredContent)).toContain(
      "Re-approve connection",
    );
    expect(credentials.accessToken).toBe("old-access-token");
    expect(renewAttempts).toBe(1);
    expect(
      (await client.listTools()).tools.map(({ name }) => name),
    ).not.toContain("reapprove_connection");

    const connectBefore = await client.callTool({
      name: "connect_webank",
      arguments: {},
    });
    expect(connectBefore.structuredContent).toMatchObject({
      status: "reauthorization_required",
      agent_id: "agt_idle",
    });
    expect(JSON.stringify(connectBefore.structuredContent)).toContain(
      "Re-approve connection",
    );
    expect(renewAttempts).toBe(2);

    ownerReapproved = true;
    const after = await client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    expect(after.structuredContent).toMatchObject({
      state: "connected",
      agent_id: "agt_idle",
      client_app_id: app.id,
    });
    expect(credentials).toMatchObject({
      agentId: "agt_idle",
      publicKey: key.publicKey,
      accessToken: "renewed-access-token",
      refreshToken: "renewed-refresh-token",
    });
    expect(renewAttempts).toBe(3);
    expect(requests).toEqual([
      "GET /v1/agent/session",
      "POST /v1/agent/session/renew",
      "GET /v1/agent/session",
      "POST /v1/agent/session/renew",
      "GET /v1/agent/session",
      "POST /v1/agent/session/renew",
      "GET /v1/agent/session",
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
