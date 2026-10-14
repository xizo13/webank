import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { Policy } from "@webank/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  newAgentKey,
  signAgentRequest,
} from "../../../agents/connector-mcp/src/signing.js";
import { createGateway } from "../src/app.js";
import type { GatewayDependencies } from "../src/types.js";

const policy: Policy = {
  schema: "policy.v1",
  user_id: "usr_test",
  per_payment_max: { amount: 30_000, currency: "CNY" },
  daily_max: { amount: 50_000, currency: "CNY" },
  monthly_max: { amount: 100_000, currency: "CNY" },
  auto_approve_below: { amount: 10_000, currency: "CNY" },
  blocked_categories: [],
  new_merchant_requires_tap: false,
  treasurer: {
    enabled: false,
    buffer_target: { amount: 0, currency: "CNY" },
    daily_topup_ceiling: { amount: 10_000, currency: "CNY" },
    monthly_topup_ceiling: { amount: 20_000, currency: "CNY" },
    protected_main_balance: { amount: 30_000, currency: "CNY" },
  },
};

function fixture() {
  const clock = { value: new Date("2026-10-14T12:00:00Z") };
  const anchored: string[] = [];
  const receiptKey = generateKeyPairSync("ed25519");
  const deps: GatewayDependencies = {
    authenticateApp: async (request) =>
      request.headers.authorization === "Bearer app" ? "usr_test" : null,
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
    anchorAudit: async (hash) => {
      anchored.push(hash);
      return `0x${createHash("sha256").update(hash).digest("hex")}`;
    },
    signReceipt: async (bytes) =>
      sign(null, bytes, receiptKey.privateKey).toString("base64url"),
    now: () => clock.value,
  };
  return {
    app: createGateway(deps, { agents: [], policies: [policy] }),
    clock,
    anchored,
  };
}

async function startPairing(
  app: ReturnType<typeof createGateway>,
  publicKey: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/oauth/device_authorization",
    payload: {
      client_name: "Claude Test",
      provider: "anthropic",
      agent_public_key: publicKey,
      requested_scopes: ["wallet:pay", "wallet:mandate", "wallet:history:self"],
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    device_code: string;
    user_code: string;
    request_number: string;
  };
}

describe("OAuth pairing and connector HTTP signatures", () => {
  const apps: ReturnType<typeof createGateway>[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  it("requires biometric plus matching request number before issuing a token", async () => {
    const { app, anchored } = fixture();
    apps.push(app);
    const key = newAgentKey();
    const pair = await startPairing(app, key.publicKey);
    const pending = await app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pair.device_code,
      },
    });
    expect(pending.statusCode).toBe(400);
    expect(pending.json()).toEqual({ error: "authorization_pending" });
    const cardResponse = await app.inject({
      method: "GET",
      url: `/v1/app/pairing/${pair.user_code}`,
      headers: { authorization: "Bearer app" },
    });
    expect(cardResponse.statusCode).toBe(200);
    expect(cardResponse.body).not.toContain(pair.request_number);
    const card = cardResponse.json().approval as { payload_hash: string };
    const missing = await app.inject({
      method: "POST",
      url: `/v1/app/pairing/${pair.user_code}/approve`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {
        verification: {
          action_hash: card.payload_hash,
          device_signature: "test-biometric-proof",
        },
      },
    });
    expect(missing.statusCode).toBe(401);
    const approval = await app.inject({
      method: "POST",
      url: `/v1/app/pairing/${pair.user_code}/approve`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {
        verification: {
          action_hash: card.payload_hash,
          device_signature: "test-biometric-proof",
          request_number: pair.request_number,
        },
      },
    });
    expect(approval.statusCode).toBe(200);
    expect(anchored).toHaveLength(1);
    const token = await app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pair.device_code,
      },
    });
    expect(token.statusCode).toBe(200);
    expect(token.json().agent_id).toMatch(/^agt_/);
    const secondPoll = await app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pair.device_code,
      },
    });
    expect(secondPoll.json()).toEqual({ error: "expired_token" });
  });

  it("verifies the connector's actual RFC 9421 signature, rejects replay and tampering, rotates refresh", async () => {
    const { app, clock } = fixture();
    apps.push(app);
    const key = newAgentKey();
    const pair = await startPairing(app, key.publicKey);
    const card = (
      await app.inject({
        method: "GET",
        url: `/v1/app/pairing/${pair.user_code}`,
        headers: { authorization: "Bearer app" },
      })
    ).json().approval;
    await app.inject({
      method: "POST",
      url: `/v1/app/pairing/${pair.user_code}/approve`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {
        verification: {
          action_hash: card.payload_hash,
          device_signature: "test-biometric-proof",
          request_number: pair.request_number,
        },
      },
    });
    const issued = (
      await app.inject({
        method: "POST",
        url: "/v1/oauth/token",
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: pair.device_code,
        },
      })
    ).json();
    const path = "/v1/agent/mandates";
    const body = JSON.stringify({
      description: "Buy headphones",
      constraints: [
        { type: "amount_range", max: { amount: 30_000, currency: "CNY" } },
        { type: "categories", allowed: ["electronics"] },
        { type: "budget", max: { amount: 30_000, currency: "CNY" } },
        { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
        {
          type: "execution_window",
          not_before: null,
          not_after: "2026-10-15T00:00:00Z",
        },
      ],
    });
    const signed = signAgentRequest({
      method: "POST",
      path,
      body,
      idempotencyKey: randomUUID(),
      agentId: issued.agent_id,
      privateKeyPem: key.privateKeyPem,
      now: clock.value.getTime(),
    });
    const headers = {
      ...signed,
      authorization: `Bearer ${issued.access_token}`,
      "content-type": "application/json",
    };
    const accepted = await app.inject({
      method: "POST",
      url: path,
      headers,
      payload: body,
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().mandate.status).toBe("pending_user");
    const replay = await app.inject({
      method: "POST",
      url: path,
      headers,
      payload: body,
    });
    expect(replay.statusCode).toBe(401);
    const tampered = await app.inject({
      method: "POST",
      url: path,
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: body,
    });
    expect(tampered.statusCode).toBe(401);
    const unsigned = await app.inject({
      method: "POST",
      url: path,
      headers: {
        authorization: `Bearer ${issued.access_token}`,
        "idempotency-key": randomUUID(),
        "content-type": "application/json",
      },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);
    const rotated = await app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
      },
    });
    expect(rotated.statusCode).toBe(200);
    const oldRefresh = await app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: issued.refresh_token,
      },
    });
    expect(oldRefresh.statusCode).toBe(400);
    clock.value = new Date(clock.value.getTime() + 901_000);
    const expiredHeaders = signAgentRequest({
      method: "POST",
      path,
      body,
      idempotencyKey: randomUUID(),
      agentId: issued.agent_id,
      privateKeyPem: key.privateKeyPem,
      now: clock.value.getTime(),
    });
    const expired = await app.inject({
      method: "POST",
      url: path,
      headers: {
        ...expiredHeaders,
        authorization: `Bearer ${issued.access_token}`,
        "content-type": "application/json",
      },
      payload: body,
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error.code).toBe("token_expired");
    const frozen = await app.inject({
      method: "POST",
      url: `/v1/app/agents/${issued.agent_id}/freeze`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {},
    });
    expect(frozen.statusCode).toBe(200);
    const revokedRefresh = await app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: rotated.json().refresh_token,
      },
    });
    expect(revokedRefresh.statusCode).toBe(400);
  });

  it("cancels pairing after three mismatched numbers", async () => {
    const { app } = fixture();
    apps.push(app);
    const pair = await startPairing(app, newAgentKey().publicKey);
    const card = (
      await app.inject({
        method: "GET",
        url: `/v1/app/pairing/${pair.user_code}`,
        headers: { authorization: "Bearer app" },
      })
    ).json().approval;
    for (let i = 0; i < 3; i++) {
      const denied = await app.inject({
        method: "POST",
        url: `/v1/app/pairing/${pair.user_code}/approve`,
        headers: {
          authorization: "Bearer app",
          "idempotency-key": randomUUID(),
        },
        payload: {
          verification: {
            action_hash: card.payload_hash,
            device_signature: "test-biometric-proof",
            request_number:
              "999999" === pair.request_number ? "888888" : "999999",
          },
        },
      });
      expect(denied.statusCode).toBe(401);
    }
    const poll = await app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pair.device_code,
      },
    });
    expect(poll.json()).toEqual({ error: "access_denied" });
  });

  it("expires a device pairing after ten minutes", async () => {
    const { app, clock } = fixture();
    apps.push(app);
    const pair = await startPairing(app, newAgentKey().publicKey);
    clock.value = new Date(clock.value.getTime() + 600_001);
    const poll = await app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: pair.device_code,
      },
    });
    expect(poll.statusCode).toBe(400);
    expect(poll.json()).toEqual({ error: "expired_token" });
    const card = await app.inject({
      method: "GET",
      url: `/v1/app/pairing/${pair.user_code}`,
      headers: { authorization: "Bearer app" },
    });
    expect(card.statusCode).toBe(403);
  });
});
