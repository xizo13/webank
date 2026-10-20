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
import { sha256 } from "../src/crypto.js";
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
    setTrustLight: async () => `0x${"a".repeat(64)}`,
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
      client_app_name: "Claude Code",
      client_app_id: `app_${createHash("sha256").update("Claude Code").digest("hex")}`,
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

  it("rejects a pairing whose client app ID does not hash its exact UTF-8 name", async () => {
    const { app } = fixture();
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/v1/oauth/device_authorization",
      payload: {
        client_name: "Claude Test",
        provider: "anthropic",
        client_app_name: "Claude Code",
        client_app_id: `app_${createHash("sha256").update("claude code").digest("hex")}`,
        agent_public_key: newAgentKey().publicKey,
        requested_scopes: ["wallet:pay"],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it.each(["unfreeze"] as const)(
    "keeps %s blocked when its audit anchor fails, including after restart",
    async (action) => {
      const directory = mkdtempSync(join(tmpdir(), "webank-action-audit-"));
      temporaryDirs.push(directory);
      const statePath = join(directory, "gateway.json");
      const target: Agent = {
        schema: "agent.v1",
        agent_id: `agt_audit_${action}`,
        user_id: "usr_test",
        display_name: "Claude Audit Test",
        provider: "anthropic",
        public_key: newAgentKey().publicKey,
        scopes: ["wallet:pay", "wallet:mandate", "wallet:history:self"],
        licence: {
          level: action === "relicense" ? "SUSPENDED" : "L",
          points: -2,
          clean_purchases: 0,
          drills_passed: 0,
        },
        status: action === "unfreeze" ? "frozen" : "active",
        created_at: "2026-10-14T11:00:00Z",
        last_used_at: null,
      };
      const first = fixture(statePath, [target]);
      apps.push(first.app);
      const prepared = await first.app.inject({
        method: "POST",
        url: `/v1/app/agents/${target.agent_id}/prepare-action`,
        headers: {
          authorization: "Bearer app",
          "idempotency-key": randomUUID(),
        },
        payload: { action },
      });
      expect(prepared.statusCode).toBe(200);
      const challenge = prepared.json();
      first.deps.anchorAudit = async () => {
        throw new Error("Audit chain unavailable");
      };
      const attempt = (app: ReturnType<typeof createGateway>) =>
        app.inject({
          method: "POST",
          url: `/v1/app/agents/${target.agent_id}/${action}`,
          headers: {
            authorization: "Bearer app",
            "idempotency-key": randomUUID(),
          },
          payload: {
            challenge_id: challenge.challenge_id,
            verification: {
              action_hash: challenge.action_hash,
              device_signature: "test-biometric-proof",
            },
          },
        });
      expect((await attempt(first.app)).statusCode).toBe(503);
      await first.app.close();
      const restored = fixture(statePath);
      apps.push(restored.app);
      const listed = await restored.app.inject({
        method: "GET",
        url: "/v1/app/agents",
        headers: { authorization: "Bearer app" },
      });
      const retained = listed
        .json()
        .items.find((item: Agent) => item.agent_id === target.agent_id);
      expect(retained.status).toBe(target.status);
      expect(retained.licence.level).toBe("AMBER");
      const retried = await attempt(restored.app);
      expect(retried.statusCode).toBe(200);
      expect(retried.json().agent.status).toBe("active");
      expect(retried.json().agent.licence.level).toBe("AMBER");
      const audit = await restored.app.inject({
        method: "GET",
        url: "/v1/app/audit",
        headers: { authorization: "Bearer app" },
      });
      const record = audit
        .json()
        .items.find(
          (item: { subject_id: string }) => item.subject_id === target.agent_id,
        );
      expect(record.record_hash).toBe(
        sha256({
          auditId: record.audit_id,
          kind: action === "unfreeze" ? "freeze" : "licence_change",
          actor: "usr_test",
          subjectId: target.agent_id,
          summary: `Local demo simulated ${action} approved by user`,
          data: {
            action,
            agent_id: target.agent_id,
            action_hash: challenge.action_hash,
            challenge_id: challenge.challenge_id,
            challenge_expires_at: challenge.expires_at,
            session_binding: sha256("Bearer app"),
            public_key: target.public_key,
            scopes: target.scopes,
            prior_status: target.status,
            prior_licence_level: "AMBER",
            root_agent_id: target.agent_id,
            demerit_count: 0,
          },
          createdAt: record.created_at,
        }),
      );
    },
  );

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
    expect(created.licence).toMatchObject({
      level: "AMBER",
      clean_purchases: 0,
      flags_30d: 0,
    });
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
      approval_timing: "upfront",
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
    expect(anchored).toHaveLength(2);
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
      approval_timing: "upfront",
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

  it("blocks a valid access grant at the exact idle deadline and requires audited same-key renewal after restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-idle-"));
    temporaryDirs.push(directory);
    const statePath = join(directory, "gateway.json");
    const first = fixture(statePath);
    apps.push(first.app);
    const key = newAgentKey();
    const otherKey = newAgentKey();
    const pair = await startPairing(first.app, key.publicKey);
    const consent = await first.app.inject({
      method: "GET",
      url: `/v1/app/pairing/${pair.user_code}`,
      headers: { authorization: "Bearer app" },
    });
    expect(consent.json().pairing.client_app_name).toBe("Claude Code");
    expect(consent.json().approval.lines).toContain("Client app: Claude Code");
    const approved = await first.app.inject({
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
    const agent = approved.json().agent as Agent;
    expect(agent.client_app_id).toBe(
      `app_${createHash("sha256").update("Claude Code").digest("hex")}`,
    );
    expect(agent.last_used_at).toBe(first.clock.value.toISOString());
    const token = (
      await first.app.inject({
        method: "POST",
        url: "/v1/oauth/token",
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: pair.device_code,
        },
      })
    ).json();
    const start = first.clock.value.getTime();
    first.clock.value = new Date(start + 7 * 86_400_000 - 1);
    const fresh = await first.app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
      },
    });
    expect(fresh.statusCode).toBe(200);
    const validGrant = fresh.json();
    first.clock.value = new Date(start + 7 * 86_400_000);
    const signFor = (
      method: string,
      path: string,
      body: string,
      privateKeyPem = key.privateKeyPem,
    ) =>
      signAgentRequest({
        method,
        path,
        body,
        idempotencyKey: randomUUID(),
        agentId: agent.agent_id,
        privateKeyPem,
        now: first.clock.value.getTime(),
      });
    const session = await first.app.inject({
      method: "GET",
      url: "/v1/agent/session",
      headers: signFor("GET", "/v1/agent/session", ""),
    });
    expect(session.json()).toMatchObject({
      state: "reauthorization_required",
      agent_id: agent.agent_id,
      client_app_name: "Claude Code",
      idle_expires_at: first.clock.value.toISOString(),
    });
    const spendPath = "/v1/agent/payments";
    const spendBody = JSON.stringify({
      mandate_id: "mdt_missing",
      payment_request: "invalid",
    });
    const spend = await first.app.inject({
      method: "POST",
      url: spendPath,
      headers: {
        ...signFor("POST", spendPath, spendBody),
        authorization: `Bearer ${validGrant.access_token}`,
        "content-type": "application/json",
      },
      payload: spendBody,
    });
    expect(spend.statusCode).toBe(401);
    expect(spend.json().error.code).toBe("reauthorization_required");
    const blockedRefresh = await first.app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: validGrant.refresh_token,
      },
    });
    expect(blockedRefresh.statusCode).toBe(401);
    expect(blockedRefresh.json().error.code).toBe("reauthorization_required");
    first.clock.value = new Date(start + 31 * 86_400_000);
    const expiredRefresh = await first.app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
      },
    });
    expect(expiredRefresh.statusCode).toBe(400);
    expect(expiredRefresh.json().error).toBe("invalid_grant");
    const ownerPath = `/v1/app/agents/${agent.agent_id}/prepare-idle-reauthorization`;
    const selfPrepare = await first.app.inject({
      method: "POST",
      url: ownerPath,
      headers: {
        ...signFor("POST", ownerPath, "{}"),
        "content-type": "application/json",
      },
      payload: "{}",
    });
    expect(selfPrepare.statusCode).toBe(401);
    const prepared = await first.app.inject({
      method: "POST",
      url: ownerPath,
      headers: { authorization: "Bearer app", "idempotency-key": randomUUID() },
      payload: {},
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().agent_summary).toMatchObject({
      client_app_id: agent.client_app_id,
      client_app_name: "Claude Code",
      scopes: agent.scopes,
    });
    const decisionPath = `/v1/app/agents/${agent.agent_id}/idle-reauthorize`;
    const decision = () =>
      first.app.inject({
        method: "POST",
        url: decisionPath,
        headers: {
          authorization: "Bearer app",
          "idempotency-key": randomUUID(),
        },
        payload: {
          challenge_id: prepared.json().challenge_id,
          verification: {
            action_hash: prepared.json().action_hash,
            device_signature: "test-biometric-proof",
          },
        },
      });
    const anchor = first.deps.anchorAudit;
    first.deps.anchorAudit = async () => {
      throw new Error("audit unavailable");
    };
    expect((await decision()).statusCode).toBe(503);
    expect(
      (
        await first.app.inject({
          method: "POST",
          url: "/v1/agent/session/renew",
          headers: {
            ...signFor("POST", "/v1/agent/session/renew", "{}"),
            "content-type": "application/json",
          },
          payload: "{}",
        })
      ).statusCode,
    ).toBe(409);
    first.deps.anchorAudit = anchor;
    const ownerApproved = await decision();
    expect(ownerApproved.statusCode).toBe(200);
    expect(ownerApproved.json().agent.reauthorization_required).toBe(true);
    expect(ownerApproved.json().renewal_expires_at).toBeTruthy();
    const audit = await first.app.inject({
      method: "GET",
      url: "/v1/app/audit",
      headers: { authorization: "Bearer app" },
    });
    const record = audit
      .json()
      .items.find((item: { summary: string }) =>
        item.summary.includes("idle re-approval"),
      );
    expect(record.record_hash).toBe(
      sha256({
        auditId: record.audit_id,
        kind: "pairing",
        actor: "usr_test",
        subjectId: agent.agent_id,
        summary: "Local demo simulated idle re-approval for Claude Code",
        data: {
          action: "idle_reauthorize",
          agent_id: agent.agent_id,
          client_app_id: agent.client_app_id,
          client_app_name: "Claude Code",
          public_key: agent.public_key,
          scopes: agent.scopes,
          last_used_at: agent.last_used_at,
          action_hash: prepared.json().action_hash,
          challenge_id: prepared.json().challenge_id,
          challenge_expires_at: prepared.json().expires_at,
          session_binding: sha256("Bearer app"),
        },
        createdAt: record.created_at,
      }),
    );
    await first.app.close();
    const second = fixture(statePath);
    apps.push(second.app);
    second.clock.value = new Date(first.clock.value);
    const wrongKey = await second.app.inject({
      method: "POST",
      url: "/v1/agent/session/renew",
      headers: {
        ...signFor(
          "POST",
          "/v1/agent/session/renew",
          "{}",
          otherKey.privateKeyPem,
        ),
        "content-type": "application/json",
      },
      payload: "{}",
    });
    expect(wrongKey.statusCode).toBe(401);
    const oldRefresh = await second.app.inject({
      method: "POST",
      url: "/v1/oauth/token",
      payload: {
        grant_type: "refresh_token",
        refresh_token: validGrant.refresh_token,
      },
    });
    expect(oldRefresh.statusCode).toBe(401);
    const renewed = await second.app.inject({
      method: "POST",
      url: "/v1/agent/session/renew",
      headers: {
        ...signFor("POST", "/v1/agent/session/renew", "{}"),
        "content-type": "application/json",
      },
      payload: "{}",
    });
    expect(renewed.statusCode).toBe(200);
    expect(renewed.json().agent_id).toBe(agent.agent_id);
    const reused = await second.app.inject({
      method: "POST",
      url: "/v1/agent/session/renew",
      headers: {
        ...signFor("POST", "/v1/agent/session/renew", "{}"),
        "content-type": "application/json",
      },
      payload: "{}",
    });
    expect(reused.statusCode).toBe(409);
    expect(
      (
        await second.app.inject({
          method: "POST",
          url: "/v1/oauth/token",
          payload: {
            grant_type: "refresh_token",
            refresh_token: validGrant.refresh_token,
          },
        })
      ).statusCode,
    ).toBe(400);
    const current = await second.app.inject({
      method: "GET",
      url: "/v1/agent/session",
      headers: signFor("GET", "/v1/agent/session", ""),
    });
    expect(current.json().state).toBe("connected");
    expect(current.json().last_used_at).toBe(second.clock.value.toISOString());
  });

  it("restores historical unlabelled agents read-only and keeps frozen and suspended precedence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-legacy-idle-"));
    temporaryDirs.push(directory);
    const statePath = join(directory, "gateway.json");
    const keys = [newAgentKey(), newAgentKey(), newAgentKey()];
    const appId = `app_${createHash("sha256").update("Claude Code").digest("hex")}`;
    const seeded: Agent[] = keys.map((key, index) => ({
      schema: "agent.v1",
      agent_id: `agt_legacy_${index}`,
      user_id: "usr_test",
      display_name: `Legacy ${index}`,
      provider: "anthropic",
      ...(index === 0
        ? {}
        : { client_app_id: appId, client_app_name: "Claude Code" }),
      public_key: key.publicKey,
      scopes: ["wallet:pay", "wallet:mandate", "wallet:history:self"],
      licence: {
        level: index === 2 ? "SUSPENDED" : "L",
        points: 0,
        clean_purchases: 0,
        drills_passed: 0,
      },
      status: index === 1 ? "frozen" : "active",
      created_at: "2026-10-01T12:00:00Z",
      last_used_at: null,
    }));
    const first = fixture(statePath, seeded);
    apps.push(first.app);
    await first.app.close();
    const restored = fixture(statePath);
    apps.push(restored.app);
    const list = await restored.app.inject({
      method: "GET",
      url: "/v1/app/agents",
      headers: { authorization: "Bearer app" },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items[0]).toMatchObject({
      client_app_id: null,
      client_app_name: null,
      reauthorization_required: true,
    });
    const states = ["reauthorization_required", "frozen", "red"];
    for (const [index, agent] of seeded.entries()) {
      const key = keys[index];
      if (!key) throw new Error("Missing test key");
      const status = await restored.app.inject({
        method: "GET",
        url: "/v1/agent/session",
        headers: signAgentRequest({
          method: "GET",
          path: "/v1/agent/session",
          body: "",
          idempotencyKey: randomUUID(),
          agentId: agent.agent_id,
          privateKeyPem: key.privateKeyPem,
          now: restored.clock.value.getTime(),
        }),
      });
      expect(status.statusCode).toBe(200);
      expect(status.json().state).toBe(states[index]);
      const prepare = await restored.app.inject({
        method: "POST",
        url: `/v1/app/agents/${agent.agent_id}/prepare-idle-reauthorization`,
        headers: {
          authorization: "Bearer app",
          "idempotency-key": randomUUID(),
        },
        payload: {},
      });
      expect(prepare.statusCode).toBe(index === 0 ? 409 : 401);
    }
    const freshKey = newAgentKey();
    const pair = await startPairing(restored.app, freshKey.publicKey);
    const consent = await restored.app.inject({
      method: "GET",
      url: `/v1/app/pairing/${pair.user_code}`,
      headers: { authorization: "Bearer app" },
    });
    const approved = await restored.app.inject({
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
    expect(approved.json().agent.client_app_id).toBe(appId);
  });

  it("expires the owner challenge and audited renewal window without granting authority", async () => {
    const key = newAgentKey();
    const agent: Agent = {
      schema: "agent.v1",
      agent_id: "agt_idle_window",
      user_id: "usr_test",
      display_name: "Claude idle",
      provider: "anthropic",
      client_app_id: `app_${createHash("sha256").update("Claude Code").digest("hex")}`,
      client_app_name: "Claude Code",
      public_key: key.publicKey,
      scopes: ["wallet:pay", "wallet:mandate", "wallet:history:self"],
      licence: { level: "L", points: 0, clean_purchases: 0, drills_passed: 0 },
      status: "active",
      created_at: "2026-10-01T12:00:00Z",
      last_used_at: "2026-10-01T12:00:00Z",
    };
    const { app, clock, anchored } = fixture(undefined, [agent]);
    apps.push(app);
    const ownerHeaders = () => ({
      authorization: "Bearer app",
      "idempotency-key": randomUUID(),
    });
    const preparePath = `/v1/app/agents/${agent.agent_id}/prepare-idle-reauthorization`;
    const decisionPath = `/v1/app/agents/${agent.agent_id}/idle-reauthorize`;
    const prepare = () =>
      app.inject({
        method: "POST",
        url: preparePath,
        headers: ownerHeaders(),
        payload: {},
      });
    const first = (await prepare()).json();
    clock.value = new Date(Date.parse(first.expires_at));
    const decide = (
      challenge: typeof first,
      actionHash = challenge.action_hash,
    ) =>
      app.inject({
        method: "POST",
        url: decisionPath,
        headers: ownerHeaders(),
        payload: {
          challenge_id: challenge.challenge_id,
          verification: {
            action_hash: actionHash,
            device_signature: "test-biometric-proof",
          },
        },
      });
    expect((await decide(first)).statusCode).toBe(409);
    expect(anchored).toHaveLength(0);
    const second = (await prepare()).json();
    expect((await decide(second, "sha256:wrong")).statusCode).toBe(401);
    expect(anchored).toHaveLength(0);
    const approved = await decide(second);
    expect(approved.statusCode).toBe(200);
    expect(anchored).toHaveLength(1);
    clock.value = new Date(Date.parse(approved.json().renewal_expires_at));
    const renew = await app.inject({
      method: "POST",
      url: "/v1/agent/session/renew",
      headers: {
        ...signAgentRequest({
          method: "POST",
          path: "/v1/agent/session/renew",
          body: "{}",
          idempotencyKey: randomUUID(),
          agentId: agent.agent_id,
          privateKeyPem: key.privateKeyPem,
          now: clock.value.getTime(),
        }),
        "content-type": "application/json",
      },
      payload: "{}",
    });
    expect(renew.statusCode).toBe(409);
    const status = await app.inject({
      method: "GET",
      url: "/v1/agent/session",
      headers: signAgentRequest({
        method: "GET",
        path: "/v1/agent/session",
        body: "",
        idempotencyKey: randomUUID(),
        agentId: agent.agent_id,
        privateKeyPem: key.privateKeyPem,
        now: clock.value.getTime(),
      }),
    });
    expect(status.json().state).toBe("reauthorization_required");
    expect(status.json().last_used_at).toBe(agent.last_used_at);
  });
});
