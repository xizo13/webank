import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Policy } from "@webank/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGateway } from "../src/app.js";
import { DurableState } from "../src/durable-state.js";
import type { GatewayDependencies, WalletFundingRail } from "../src/types.js";

const wallet = `0x${"2".repeat(40)}` as const;
const policy: Policy = {
  schema: "policy.v1",
  user_id: "usr_owner",
  per_payment_max: { amount: 30_000, currency: "CNY" },
  daily_max: { amount: 50_000, currency: "CNY" },
  monthly_max: { amount: 100_000, currency: "CNY" },
  auto_approve_below: { amount: 10_000, currency: "CNY" },
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
const agent: Agent = {
  schema: "agent.v1",
  agent_id: "agt_test",
  user_id: "usr_owner",
  display_name: "Test connector",
  provider: "anthropic",
  public_key: "p256:test-agent-key",
  scopes: ["wallet:pay", "wallet:mandate"],
  licence: { level: "L", points: 0, clean_purchases: 0, drills_passed: 0 },
  status: "active",
  created_at: "2026-10-20T00:00:00Z",
  last_used_at: "2026-10-20T00:00:00Z",
};
const ownerHeaders = { authorization: "Bearer owner" };
const amount = { amount: 100, currency: "CNY" };

function fixture(
  statePath: string,
  options: {
    clock?: { value: Date };
    initialWalletEnabled?: boolean;
    anchorAudit?: GatewayDependencies["anchorAudit"];
  } = {},
) {
  const rail = {
    deployment: {
      main: `0x${"1".repeat(40)}`,
      wallet,
      token: `0x${"3".repeat(40)}`,
    },
    snapshot: async () => ({
      mainBalance: 100_000n,
      walletBalance: 0n,
      walletFrozen: false,
      blockNumber: 5n,
      observedAt: options.clock?.value.toISOString() ?? "2026-10-20T00:00:00Z",
    }),
  } as WalletFundingRail;
  const deps: GatewayDependencies = {
    statePath,
    stateContext: "wallet-enable-test",
    now: () => options.clock?.value ?? new Date("2026-10-20T00:00:00Z"),
    initialWalletEnabled: options.initialWalletEnabled ?? false,
    walletFunding: rail,
    authenticateApp: async (request) =>
      request.headers.authorization === ownerHeaders.authorization
        ? "usr_owner"
        : null,
    authenticateAgent: async (request) =>
      request.headers.authorization === "Bearer agent" ? agent : null,
    verifyWalletEnableProof: async (hash, value) => {
      const proof = value as {
        action_hash?: string;
        device_signature?: string;
      };
      return (
        proof?.action_hash === hash &&
        proof.device_signature === "simulated-local-wallet-enable"
      );
    },
    recordNumberMatchFailure: async () => {},
    lookupMerchant: async () => null,
    reserveMandate: async () => true,
    releaseMandate: async () => {},
    assessRisk: async () => ({
      result: "deny",
      signals: [],
      explanation: "test",
    }),
    evaluateGuardian: async () => ({
      verdict: "step_up",
      reasons: [],
      user_explanation: "test",
    }),
    executePayment: async () => {
      throw new Error("unreachable");
    },
    anchorAudit: options.anchorAudit ?? (async () => `0x${"4".repeat(64)}`),
    signReceipt: async () => "unused",
  };
  return createGateway(deps, { agents: [agent], policies: [policy] });
}

async function prepare(app: ReturnType<typeof fixture>) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/app/agent-wallet/enable/prepare",
    headers: ownerHeaders,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    challenge_id: string;
    action_hash: string;
    expires_at: string;
    simulated: true;
  };
}

function commit(
  app: ReturnType<typeof fixture>,
  challenge: Awaited<ReturnType<typeof prepare>>,
  key = "enable-one",
  signature = "simulated-local-wallet-enable",
) {
  return app.inject({
    method: "POST",
    url: "/v1/app/agent-wallet/enable",
    headers: { ...ownerHeaders, "idempotency-key": key },
    payload: {
      challenge_id: challenge.challenge_id,
      verification: {
        action_hash: challenge.action_hash,
        device_signature: signature,
      },
    },
  });
}

describe("fresh owner Agent Wallet enablement", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const run of cleanup.splice(0).reverse()) await run();
  });

  it("blocks pairing, agent spending and funding until one audited owner proof succeeds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-wallet-enable-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const statePath = join(directory, "gateway.json");
    let anchors = 0;
    const app = fixture(statePath, {
      anchorAudit: async () => {
        anchors++;
        return `0x${"4".repeat(64)}`;
      },
    });
    cleanup.push(() => app.close());
    const home = await app.inject({
      method: "GET",
      url: "/v1/app/home",
      headers: ownerHeaders,
    });
    expect(home.json().agent_wallet.enabled).toBe(false);
    for (const [url, headers, payload] of [
      ["/v1/oauth/device_authorization", {}, {}],
      [
        "/v1/app/pairing/MISSING/approve",
        { ...ownerHeaders, "idempotency-key": "pair-disabled" },
        {},
      ],
      [
        "/v1/agent/mandates",
        {
          authorization: "Bearer agent",
          "idempotency-key": "mandate-disabled",
        },
        {},
      ],
      [
        "/v1/agent/payments",
        {
          authorization: "Bearer agent",
          "idempotency-key": "payment-disabled",
        },
        {},
      ],
      ["/v1/app/agent-wallet/funding/prepare", ownerHeaders, { amount }],
    ] as const) {
      const denied = await app.inject({
        method: "POST",
        url,
        headers,
        payload,
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("wallet_disabled");
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/app/agent-wallet/enable/prepare",
          headers: { authorization: "Bearer agent" },
        })
      ).statusCode,
    ).toBe(401);
    const challenge = await prepare(app);
    expect(challenge.action_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      (await commit(app, challenge, "bad", "not-a-proof")).statusCode,
    ).toBe(401);
    expect(anchors).toBe(0);
    const enabled = await commit(app, challenge);
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toEqual({ enabled: true, simulated: true });
    expect(anchors).toBe(1);
    expect((await commit(app, challenge)).statusCode).toBe(200);
    expect((await commit(app, challenge, "other-key")).statusCode).toBe(409);
    expect(anchors).toBe(1);
    const confirmed = await app.inject({
      method: "GET",
      url: "/v1/app/home",
      headers: ownerHeaders,
    });
    expect(confirmed.json().agent_wallet.enabled).toBe(true);
    const funding = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/funding/prepare",
      headers: ownerHeaders,
      payload: { amount },
    });
    expect(funding.statusCode).toBe(200);
    await app.close();
    const reopened = fixture(statePath);
    cleanup.push(() => reopened.close());
    expect(
      (
        await reopened.inject({
          method: "GET",
          url: "/v1/app/home",
          headers: ownerHeaders,
        })
      ).json().agent_wallet.enabled,
    ).toBe(true);
  });

  it("keeps the wallet disabled on expired proof or audit failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-wallet-audit-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const clock = { value: new Date("2026-10-20T00:00:00Z") };
    const app = fixture(join(directory, "gateway.json"), {
      clock,
      anchorAudit: async () => {
        throw new Error("audit unavailable");
      },
    });
    cleanup.push(() => app.close());
    const expired = await prepare(app);
    clock.value = new Date("2026-10-20T00:01:00Z");
    expect((await commit(app, expired)).statusCode).toBe(409);
    const fresh = await prepare(app);
    expect((await commit(app, fresh)).statusCode).toBe(503);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/app/home",
          headers: ownerHeaders,
        })
      ).json().agent_wallet.enabled,
    ).toBe(false);
  });

  it("fences an ambiguous post-rename save and reconciles from durable state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-wallet-ambiguous-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const statePath = join(directory, "gateway.json");
    const app = fixture(statePath);
    cleanup.push(() => app.close());
    const challenge = await prepare(app);
    const save = DurableState.prototype.save;
    vi.spyOn(DurableState.prototype, "save").mockImplementation(
      function (payload) {
        save.call(this, payload);
        (this as unknown as { ambiguous: boolean }).ambiguous = true;
        throw new Error("post-rename fsync failure");
      },
    );
    expect((await commit(app, challenge)).statusCode).toBe(503);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/app/home",
          headers: ownerHeaders,
        })
      ).statusCode,
    ).toBe(503);
    vi.restoreAllMocks();
    await app.close();
    const reopened = fixture(statePath);
    cleanup.push(() => reopened.close());
    expect(
      (
        await reopened.inject({
          method: "GET",
          url: "/v1/app/home",
          headers: ownerHeaders,
        })
      ).json().agent_wallet.enabled,
    ).toBe(true);
  });

  it("rolls back enablement after a pre-rename durable save failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-wallet-pre-rename-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const statePath = join(directory, "gateway.json");
    const app = fixture(statePath);
    cleanup.push(() => app.close());
    const challenge = await prepare(app);
    chmodSync(directory, 0o500);
    try {
      expect((await commit(app, challenge)).statusCode).toBe(503);
    } finally {
      chmodSync(directory, 0o700);
    }
    const home = await app.inject({
      method: "GET",
      url: "/v1/app/home",
      headers: ownerHeaders,
    });
    expect(home.statusCode).toBe(200);
    expect(home.json().agent_wallet.enabled).toBe(false);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/app/agent-wallet/funding/prepare",
          headers: ownerHeaders,
          payload: { amount },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("loads an established snapshot missing wallet state as enabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-wallet-legacy-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const statePath = join(directory, "gateway.json");
    const old = fixture(statePath, { initialWalletEnabled: true });
    await old.ready();
    await old.close();
    const envelope = JSON.parse(readFileSync(statePath, "utf8"));
    delete envelope.payload.walletEnabled;
    delete envelope.payload.walletEnableChallenges;
    envelope.sha256 = createHash("sha256")
      .update(JSON.stringify(envelope.payload))
      .digest("hex");
    writeFileSync(statePath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    chmodSync(statePath, 0o600);
    const reopened = fixture(statePath);
    cleanup.push(() => reopened.close());
    const home = await reopened.inject({
      method: "GET",
      url: "/v1/app/home",
      headers: ownerHeaders,
    });
    expect(home.json().agent_wallet.enabled).toBe(true);
  });

  it("rejects a new snapshot with missing owner enablement entries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-wallet-incomplete-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const statePath = join(directory, "gateway.json");
    const app = fixture(statePath);
    await app.ready();
    await app.close();
    const envelope = JSON.parse(readFileSync(statePath, "utf8"));
    envelope.payload.walletEnabled = [];
    envelope.sha256 = createHash("sha256")
      .update(JSON.stringify(envelope.payload))
      .digest("hex");
    writeFileSync(statePath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    chmodSync(statePath, 0o600);
    expect(() => fixture(statePath)).toThrow(
      "Gateway wallet enabled state is incomplete",
    );
  });
});
