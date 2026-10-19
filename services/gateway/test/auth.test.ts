import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Policy } from "@webank/contracts";
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

function fixture(statePath?: string, seedAgents: Agent[] = []) {
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
    statePath,
  };
  return {
    app: createGateway(deps, { agents: seedAgents, policies: [policy] }),
    deps,
    clock,
    anchored,
  };
}

async function startPairing(
  app: ReturnType<typeof createGateway>,
  publicKey: string,
  provider = "anthropic",
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/oauth/device_authorization",
    payload: {
      client_name: "Claude Test",
      provider,
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
  const temporaryDirs: string[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const directory of temporaryDirs.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it("pairs a fresh identity even when a same-provider revoked record exists", async () => {
    const priorKey = newAgentKey();
    const prior: Agent = {
      schema: "agent.v1",
      agent_id: "agt_prior_anthropic",
      user_id: "usr_test",
      display_name: "Previous Claude",
      provider: "Anthropic",
      public_key: priorKey.publicKey,
      scopes: ["wallet:pay", "wallet:mandate", "wallet:history:self"],
      licence: { level: "L", points: -1, clean_purchases: 0, drills_passed: 0 },
      status: "revoked",
      deleted_at: "2026-10-14T11:00:00Z",
      created_at: "2026-10-13T12:00:00Z",
      last_used_at: null,
    };
    const { app } = fixture(undefined, [prior]);
    apps.push(app);
    const pair = await startPairing(app, newAgentKey().publicKey, "Anthropic");
    const path = `/v1/app/pairing/${pair.user_code}`;
    const consent = await app.inject({
      method: "GET",
      url: path,
      headers: { authorization: "Bearer app" },
    });
    expect(consent.statusCode).toBe(200);
    expect(consent.json().replacement_candidates).toEqual([]);
    expect(consent.json().pairing.replacement).toBeNull();
    const retiredSelection = await app.inject({
      method: "POST",
      url: `${path}/select-replacement`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: { replaces_agent_id: prior.agent_id },
    });
    expect(retiredSelection.statusCode).toBe(410);
    const approved = await app.inject({
      method: "POST",
      url: `${path}/approve`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {
        verification: {
          action_hash: consent.json().approval.payload_hash,
          device_signature: "test-biometric-proof",
          request_number: pair.request_number,
        },
      },
    });
    expect(approved.statusCode).toBe(200);
    const created = approved.json().agent;
    expect(created.agent_id).not.toBe(prior.agent_id);
    expect(created.lineage).toEqual({
      root_agent_id: created.agent_id,
      replaces_agent_id: null,
      replaced_by_agent_id: null,
    });
    expect(created.licence).toMatchObject({ level: "L", points: 0 });
    const history = await app.inject({
      method: "GET",
      url: `/v1/app/agents/${prior.agent_id}/history`,
      headers: { authorization: "Bearer app" },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().root_agent_id).toBe(prior.agent_id);
  });

  it("restores frozen key status and blocked grants, then refuses corrupt state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-frozen-restart-"));
    temporaryDirs.push(directory);
    const statePath = join(directory, "gateway.json");
    const { app, deps, clock } = fixture(statePath);
    apps.push(app);
    expect(() =>
      createGateway(deps, { agents: [], policies: [policy] }),
    ).toThrow(/active writer/);
    const key = newAgentKey();
    const pair = await startPairing(app, key.publicKey);
    const card = (
      await app.inject({
        method: "GET",
        url: `/v1/app/pairing/${pair.user_code}`,
        headers: { authorization: "Bearer app" },
      })
    ).json().approval;
    const approved = await app.inject({
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
    expect(approved.statusCode).toBe(200);
    const token = (
      await app.inject({
        method: "POST",
        url: "/v1/oauth/token",
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: pair.device_code,
        },
      })
    ).json();
    expect(token.agent_id).toMatch(/^agt_/);
    const pendingBody = JSON.stringify({
      description: "Buy headphones",
      user_text: "Buy headphones under ¥10",
      intent_level: "open",
      constraints: [
        { type: "amount_range", max: { amount: 1_000, currency: "CNY" } },
        { type: "categories", allowed: ["electronics"] },
        { type: "budget", max: { amount: 1_000, currency: "CNY" } },
        { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
        {
          type: "execution_window",
          not_before: null,
          not_after: "2026-10-15T00:00:00Z",
        },
      ],
    });
    const pendingMandate = await app.inject({
      method: "POST",
      url: "/v1/agent/mandates",
      headers: {
        ...signAgentRequest({
          method: "POST",
          path: "/v1/agent/mandates",
          body: pendingBody,
          idempotencyKey: randomUUID(),
          agentId: token.agent_id,
          privateKeyPem: key.privateKeyPem,
          now: clock.value.getTime(),
        }),
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
      },
      payload: pendingBody,
    });
    expect(pendingMandate.statusCode).toBe(202);
    const frozen = await app.inject({
      method: "POST",
      url: `/v1/app/agents/${token.agent_id}/freeze`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {},
    });
    expect(frozen.statusCode).toBe(200);
    const persistedNonceHeaders = signAgentRequest({
      method: "GET",
      path: "/v1/agent/session",
      body: "",
      idempotencyKey: randomUUID(),
      agentId: token.agent_id,
      privateKeyPem: key.privateKeyPem,
      now: clock.value.getTime(),
    });
    const beforeRestart = await app.inject({
      method: "GET",
      url: "/v1/agent/session",
      headers: persistedNonceHeaders,
    });
    expect(beforeRestart.statusCode).toBe(200);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const restarted = createGateway(deps, { agents: [], policies: [policy] });
    apps.push(restarted);
    const sessionPath = "/v1/agent/session";
    const replayedNonce = await restarted.inject({
      method: "GET",
      url: sessionPath,
      headers: persistedNonceHeaders,
    });
    expect(replayedNonce.statusCode).toBe(401);
    expect(replayedNonce.json().error.code).toBe("bad_signature");
    const session = await restarted.inject({
      method: "GET",
      url: sessionPath,
      headers: signAgentRequest({
        method: "GET",
        path: sessionPath,
        body: "",
        idempotencyKey: randomUUID(),
        agentId: token.agent_id,
        privateKeyPem: key.privateKeyPem,
        now: clock.value.getTime(),
      }),
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().state).toBe("frozen");
    const refresh = await restarted.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
      },
    });
    expect(refresh.statusCode).toBe(400);
    const payBody = JSON.stringify({
      mandate_id: "mdt_unknown",
      payment_request: "invalid",
    });
    const pay = await restarted.inject({
      method: "POST",
      url: "/v1/agent/payments",
      headers: {
        ...signAgentRequest({
          method: "POST",
          path: "/v1/agent/payments",
          body: payBody,
          idempotencyKey: randomUUID(),
          agentId: token.agent_id,
          privateKeyPem: key.privateKeyPem,
          now: clock.value.getTime(),
        }),
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
      },
      payload: payBody,
    });
    expect(pay.json().error.code).toBe("agent_frozen");
    const revokeBody = "{}";
    const revoke = await restarted.inject({
      method: "POST",
      url: "/v1/agent/session/revoke",
      headers: {
        ...signAgentRequest({
          method: "POST",
          path: "/v1/agent/session/revoke",
          body: revokeBody,
          idempotencyKey: randomUUID(),
          agentId: token.agent_id,
          privateKeyPem: key.privateKeyPem,
          now: clock.value.getTime(),
        }),
        "content-type": "application/json",
      },
      payload: revokeBody,
    });
    expect(revoke.statusCode).toBe(200);
    const revokedMandate = await restarted.inject({
      method: "GET",
      url: "/v1/app/mandates",
      headers: { authorization: "Bearer app" },
    });
    expect(
      revokedMandate
        .json()
        .items.find(
          (item: { mandate_id: string }) =>
            item.mandate_id === pendingMandate.json().mandate.mandate_id,
        )?.status,
    ).toBe("cancelled");
    const resolvedCards = await restarted.inject({
      method: "GET",
      url: "/v1/app/approvals",
      headers: { authorization: "Bearer app" },
    });
    expect(
      resolvedCards
        .json()
        .items.find(
          (item: { subject_id: string }) =>
            item.subject_id === pendingMandate.json().mandate.mandate_id,
        )?.status,
    ).toBe("rejected");
    await restarted.close();
    apps.splice(apps.indexOf(restarted), 1);
    const revokedInstance = createGateway(deps, {
      agents: [],
      policies: [policy],
    });
    apps.push(revokedInstance);
    const revokedStatus = await revokedInstance.inject({
      method: "GET",
      url: sessionPath,
      headers: signAgentRequest({
        method: "GET",
        path: sessionPath,
        body: "",
        idempotencyKey: randomUUID(),
        agentId: token.agent_id,
        privateKeyPem: key.privateKeyPem,
        now: clock.value.getTime(),
      }),
    });
    expect(revokedStatus.json().state).toBe("revoked");
    await revokedInstance.close();
    apps.splice(apps.indexOf(revokedInstance), 1);
    expect(() =>
      createGateway(
        { ...deps, stateContext: "another-chain" },
        { agents: [], policies: [policy] },
      ),
    ).toThrow(/another deployment/);
    writeFileSync(`${statePath}.lock`, "99999999", { mode: 0o600 });
    expect(() =>
      createGateway(deps, { agents: [], policies: [policy] }),
    ).toThrow(/stale writer lock/);
    rmSync(`${statePath}.lock`);
    writeFileSync(statePath, "corrupt", { mode: 0o600 });
    expect(() =>
      createGateway(deps, { agents: [], policies: [policy] }),
    ).toThrow(/corrupt/);
    rmSync(statePath);
    expect(() =>
      createGateway(deps, { agents: [], policies: [policy] }),
    ).toThrow(/missing after prior initialization/);
  });

  it("reports a suspended key without a spending token but rejects an invalid key proof", async () => {
    const key = newAgentKey();
    const suspended: Agent = {
      schema: "agent.v1",
      agent_id: "agt_suspended_test",
      user_id: "usr_test",
      display_name: "Claude Suspended",
      provider: "anthropic",
      public_key: key.publicKey,
      scopes: ["wallet:pay", "wallet:mandate", "wallet:history:self"],
      licence: {
        level: "SUSPENDED",
        points: -2,
        clean_purchases: 0,
        drills_passed: 0,
      },
      status: "active",
      created_at: "2026-10-14T12:00:00Z",
      last_used_at: null,
    };
    const { app, clock } = fixture(undefined, [suspended]);
    apps.push(app);
    const path = "/v1/agent/payments";
    const body = JSON.stringify({ mandate_id: "mdt_unknown" });
    const signed = (privateKeyPem: string) =>
      signAgentRequest({
        method: "POST",
        path,
        body,
        idempotencyKey: randomUUID(),
        agentId: suspended.agent_id,
        privateKeyPem,
        now: clock.value.getTime(),
      });
    const blocked = await app.inject({
      method: "POST",
      url: path,
      headers: {
        ...signed(key.privateKeyPem),
        "content-type": "application/json",
      },
      payload: body,
    });
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error.code).toBe("agent_frozen");
    const forged = await app.inject({
      method: "POST",
      url: path,
      headers: {
        ...signed(newAgentKey().privateKeyPem),
        "content-type": "application/json",
      },
      payload: body,
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error.code).toBe("bad_signature");
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
      user_text: "Buy headphones",
      intent_level: "open",
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
    const frozenBody = JSON.stringify({
      mandate_id: "mdt_unknown",
      payment_request: "invalid",
    });
    const frozenPay = await app.inject({
      method: "POST",
      url: "/v1/agent/payments",
      headers: {
        ...signAgentRequest({
          method: "POST",
          path: "/v1/agent/payments",
          body: frozenBody,
          idempotencyKey: randomUUID(),
          agentId: issued.agent_id,
          privateKeyPem: key.privateKeyPem,
          now: clock.value.getTime(),
        }),
        authorization: `Bearer ${issued.access_token}`,
        "content-type": "application/json",
      },
      payload: frozenBody,
    });
    expect(frozenPay.statusCode).toBe(401);
    expect(frozenPay.json().error.code).toBe("agent_frozen");
    const revokedRefresh = await app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: rotated.json().refresh_token,
      },
    });
    expect(revokedRefresh.statusCode).toBe(400);
    const sessionPath = "/v1/agent/session";
    const sessionHeaders = signAgentRequest({
      method: "GET",
      path: sessionPath,
      body: "",
      idempotencyKey: randomUUID(),
      agentId: issued.agent_id,
      privateKeyPem: key.privateKeyPem,
      now: clock.value.getTime(),
    });
    const frozenSession = await app.inject({
      method: "GET",
      url: sessionPath,
      headers: sessionHeaders,
    });
    expect(frozenSession.statusCode).toBe(200);
    expect(frozenSession.json().state).toBe("frozen");
    const agentRecoveryAttempt = await app.inject({
      method: "POST",
      url: `/v1/app/agents/${issued.agent_id}/prepare-action`,
      headers: {
        ...signAgentRequest({
          method: "POST",
          path: `/v1/app/agents/${issued.agent_id}/prepare-action`,
          body: JSON.stringify({ action: "unfreeze" }),
          idempotencyKey: randomUUID(),
          agentId: issued.agent_id,
          privateKeyPem: key.privateKeyPem,
          now: clock.value.getTime(),
        }),
        "content-type": "application/json",
      },
      payload: JSON.stringify({ action: "unfreeze" }),
    });
    expect(agentRecoveryAttempt.statusCode).toBe(401);
    const sessionReplay = await app.inject({
      method: "GET",
      url: sessionPath,
      headers: sessionHeaders,
    });
    expect(sessionReplay.statusCode).toBe(401);
    const prepared = await app.inject({
      method: "POST",
      url: `/v1/app/agents/${issued.agent_id}/prepare-action`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: { action: "unfreeze" },
    });
    expect(prepared.statusCode).toBe(200);
    const challenge = prepared.json();
    const deniedUnfreeze = await app.inject({
      method: "POST",
      url: `/v1/app/agents/${issued.agent_id}/unfreeze`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {
        challenge_id: challenge.challenge_id,
        verification: {
          action_hash: challenge.action_hash,
          device_signature: "wrong-proof",
        },
      },
    });
    expect(deniedUnfreeze.statusCode).toBe(401);
    const unfrozen = await app.inject({
      method: "POST",
      url: `/v1/app/agents/${issued.agent_id}/unfreeze`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {
        challenge_id: challenge.challenge_id,
        verification: {
          action_hash: challenge.action_hash,
          device_signature: "test-biometric-proof",
        },
      },
    });
    expect(unfrozen.statusCode).toBe(200);
    expect(unfrozen.json().agent.status).toBe("active");
    const reusedChallenge = await app.inject({
      method: "POST",
      url: `/v1/app/agents/${issued.agent_id}/unfreeze`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {
        challenge_id: challenge.challenge_id,
        verification: {
          action_hash: challenge.action_hash,
          device_signature: "test-biometric-proof",
        },
      },
    });
    expect(reusedChallenge.statusCode).toBe(409);
    const restoredRefresh = await app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: rotated.json().refresh_token,
      },
    });
    expect(restoredRefresh.statusCode).toBe(200);
    const deleted = await app.inject({
      method: "POST",
      url: `/v1/app/agents/${issued.agent_id}/revoke`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: { confirmation_agent_id: issued.agent_id },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().agent.deleted_at).toBeTruthy();
    const deletedStatus = await app.inject({
      method: "GET",
      url: sessionPath,
      headers: signAgentRequest({
        method: "GET",
        path: sessionPath,
        body: "",
        idempotencyKey: randomUUID(),
        agentId: issued.agent_id,
        privateKeyPem: key.privateKeyPem,
        now: clock.value.getTime(),
      }),
    });
    expect(deletedStatus.json().state).toBe("revoked");
    const revokedBody = JSON.stringify({
      mandate_id: "mdt_unknown",
      payment_request: "invalid",
    });
    const revokedPath = "/v1/agent/payments";
    const revokedSignature = signAgentRequest({
      method: "POST",
      path: revokedPath,
      body: revokedBody,
      idempotencyKey: randomUUID(),
      agentId: issued.agent_id,
      privateKeyPem: key.privateKeyPem,
      now: clock.value.getTime(),
    });
    const revokedPay = await app.inject({
      method: "POST",
      url: revokedPath,
      headers: {
        ...revokedSignature,
        authorization: `Bearer ${restoredRefresh.json().access_token}`,
        "content-type": "application/json",
      },
      payload: revokedBody,
    });
    expect(revokedPay.statusCode).toBe(401);
    expect(revokedPay.json().error.code).toBe("agent_frozen");
    const wrongKey = newAgentKey();
    const forged = await app.inject({
      method: "POST",
      url: revokedPath,
      headers: {
        ...signAgentRequest({
          method: "POST",
          path: revokedPath,
          body: revokedBody,
          idempotencyKey: randomUUID(),
          agentId: issued.agent_id,
          privateKeyPem: wrongKey.privateKeyPem,
          now: clock.value.getTime(),
        }),
        authorization: `Bearer ${restoredRefresh.json().access_token}`,
        "content-type": "application/json",
      },
      payload: revokedBody,
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error.code).toBe("bad_signature");
    const deletedRefresh = await app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: restoredRefresh.json().refresh_token,
      },
    });
    expect(deletedRefresh.statusCode).toBe(400);
    const deletedList = await app.inject({
      method: "GET",
      url: "/v1/app/agents",
      headers: { authorization: "Bearer app" },
    });
    expect(deletedList.json().items).toHaveLength(0);
    const retainedHistory = await app.inject({
      method: "GET",
      url: `/v1/app/agents/${issued.agent_id}/history`,
      headers: { authorization: "Bearer app" },
    });
    expect(retainedHistory.statusCode).toBe(200);
    expect(retainedHistory.json().items.length).toBeGreaterThan(0);
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

  it("lists claimed pairings, rotates the number, and rejects only the stale number without a demerit", async () => {
    const { app, clock } = fixture();
    apps.push(app);
    const pair = await startPairing(app, newAgentKey().publicKey);
    const consent = await app.inject({
      method: "GET",
      url: `/v1/app/pairing/${pair.user_code}`,
      headers: { authorization: "Bearer app" },
    });
    expect(consent.statusCode).toBe(200);
    const pendingList = await app.inject({
      method: "GET",
      url: "/v1/app/pairings?status=pending",
      headers: { authorization: "Bearer app" },
    });
    expect(pendingList.json().items[0]).toMatchObject({
      user_code: pair.user_code,
      status: "pending",
    });
    expect(pendingList.body).not.toContain(pair.request_number);
    clock.value = new Date(clock.value.getTime() + 181_000);
    const waited = await app.inject({
      method: "GET",
      url: `/v1/oauth/device_authorization/${pair.device_code}?wait=0`,
    });
    expect(waited.json().status).toBe("still_pending");
    const currentNumber = waited.json().request_number as string;
    expect(currentNumber).toMatch(/^\d{6}$/);
    expect(currentNumber).not.toBe(pair.request_number);
    const card = consent.json().approval;
    const oldNumber = await app.inject({
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
    expect(oldNumber.statusCode).toBe(409);
    expect(oldNumber.json().error.code).toBe("request_number_expired");
    const approved = await app.inject({
      method: "POST",
      url: `/v1/app/pairing/${pair.user_code}/approve`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {
        verification: {
          action_hash: card.payload_hash,
          device_signature: "test-biometric-proof",
          request_number: currentNumber,
        },
      },
    });
    expect(approved.statusCode).toBe(200);
    const approvedList = await app.inject({
      method: "GET",
      url: "/v1/app/pairings?status=approved",
      headers: { authorization: "Bearer app" },
    });
    expect(approvedList.json().items[0].status).toBe("approved");
  });

  it("wakes a 55-second pairing wait after the owner approves", async () => {
    const { app } = fixture();
    apps.push(app);
    const pair = await startPairing(app, newAgentKey().publicKey);
    const unclaimed = await app.inject({
      method: "GET",
      url: "/v1/app/pairings?status=pending",
      headers: { authorization: "Bearer app" },
    });
    expect(unclaimed.json().items).toHaveLength(0);
    const consent = await app.inject({
      method: "GET",
      url: `/v1/app/pairing/${pair.user_code}`,
      headers: { authorization: "Bearer app" },
    });
    expect(consent.statusCode).toBe(200);
    const claimed = await app.inject({
      method: "GET",
      url: "/v1/app/pairings?status=pending",
      headers: { authorization: "Bearer app" },
    });
    expect(claimed.json().items[0].user_code).toBe(pair.user_code);
    const waitStartedAt = Date.now();
    let waitResolved = false;
    const waiting = app
      .inject({
        method: "GET",
        url: `/v1/oauth/device_authorization/${pair.device_code}?wait=55`,
      })
      .then((result) => {
        waitResolved = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(waitResolved).toBe(false);
    const approved = await app.inject({
      method: "POST",
      url: `/v1/app/pairing/${pair.user_code}/approve`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {
        verification: {
          action_hash: consent.json().approval.payload_hash,
          device_signature: "test-biometric-proof",
          request_number: pair.request_number,
        },
      },
    });
    expect(approved.statusCode).toBe(200);
    const result = await waiting;
    expect(result.statusCode).toBe(200);
    expect(result.json().status).toBe("approved");
    expect(Date.now() - waitStartedAt).toBeLessThan(2_000);
  });

  it("revokes the old key on explicit re-pair without linking the new identity", async () => {
    const { app, clock } = fixture();
    apps.push(app);
    const oldKey = newAgentKey();
    const first = await startPairing(app, oldKey.publicKey);
    const firstCard = (
      await app.inject({
        method: "GET",
        url: `/v1/app/pairing/${first.user_code}`,
        headers: { authorization: "Bearer app" },
      })
    ).json().approval;
    const firstApproval = await app.inject({
      method: "POST",
      url: `/v1/app/pairing/${first.user_code}/approve`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {
        verification: {
          action_hash: firstCard.payload_hash,
          device_signature: "test-biometric-proof",
          request_number: first.request_number,
        },
      },
    });
    expect(firstApproval.statusCode).toBe(200);
    const oldId = firstApproval.json().agent.agent_id as string;
    const revokeBody = JSON.stringify({ re_pair: true });
    const revoked = await app.inject({
      method: "POST",
      url: "/v1/agent/session/revoke",
      headers: {
        ...signAgentRequest({
          method: "POST",
          path: "/v1/agent/session/revoke",
          body: revokeBody,
          idempotencyKey: randomUUID(),
          agentId: oldId,
          privateKeyPem: oldKey.privateKeyPem,
          now: clock.value.getTime(),
        }),
        "content-type": "application/json",
      },
      payload: revokeBody,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toEqual({ state: "revoked" });
    const next = await startPairing(app, newAgentKey().publicKey);
    const nextCard = (
      await app.inject({
        method: "GET",
        url: `/v1/app/pairing/${next.user_code}`,
        headers: { authorization: "Bearer app" },
      })
    ).json().approval;
    const approved = await app.inject({
      method: "POST",
      url: `/v1/app/pairing/${next.user_code}/approve`,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {
        verification: {
          action_hash: nextCard.payload_hash,
          device_signature: "test-biometric-proof",
          request_number: next.request_number,
        },
      },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().agent.lineage).toMatchObject({
      root_agent_id: approved.json().agent.agent_id,
      replaces_agent_id: null,
    });
    const history = await app.inject({
      method: "GET",
      url: `/v1/app/agents/${oldId}/history`,
      headers: { authorization: "Bearer app" },
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().root_agent_id).toBe(oldId);
  });

  it("expires a device pairing after ten minutes", async () => {
    const { app, clock } = fixture();
    apps.push(app);
    const pair = await startPairing(app, newAgentKey().publicKey);
    const claimed = await app.inject({
      method: "GET",
      url: `/v1/app/pairing/${pair.user_code}`,
      headers: { authorization: "Bearer app" },
    });
    expect(claimed.statusCode).toBe(200);
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
    const expiredList = await app.inject({
      method: "GET",
      url: "/v1/app/pairings?status=expired",
      headers: { authorization: "Bearer app" },
    });
    expect(expiredList.json().items[0].status).toBe("expired");
  });
});
