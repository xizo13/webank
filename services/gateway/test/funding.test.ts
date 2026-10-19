import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../src/app.js";
import type {
  GatewayDependencies,
  TransferEvidence,
  WalletFundingRail,
} from "../src/types.js";

const main = `0x${"1".repeat(40)}` as const;
const wallet = `0x${"2".repeat(40)}` as const;
const token = `0x${"3".repeat(40)}` as const;

function rail() {
  let mainBalance = 866_000n;
  let walletBalance = 0n;
  let blockNumber = 1n;
  let calls = 0;
  const funded = new Map<string, TransferEvidence>();
  const swept = new Map<string, TransferEvidence>();
  const api: WalletFundingRail = {
    deployment: { main, wallet, token },
    snapshot: async () => ({
      mainBalance,
      walletBalance,
      walletFrozen: false,
      blockNumber,
      observedAt: "2026-10-15T12:00:00.000Z",
    }),
    fund: async (id, amount) => {
      calls++;
      if (mainBalance < amount) throw new Error("insufficient main");
      mainBalance -= amount;
      walletBalance += amount;
      blockNumber++;
      const hash = `0x${blockNumber.toString(16).padStart(64, "0")}` as const;
      funded.set(id, { hash, blockNumber, amount, main, wallet });
      return hash;
    },
    fundingApplied: async (id) => funded.has(id),
    fundingEvidence: async (hash, id) => {
      const item = funded.get(id);
      if (!item || item.hash !== hash) throw new Error("missing evidence");
      return item;
    },
    findFundingEvidence: async (id) => funded.get(id),
    sweep: async (id, amount) => {
      if (walletBalance < amount) throw new Error("insufficient wallet");
      walletBalance -= amount;
      mainBalance += amount;
      blockNumber++;
      const hash = `0x${blockNumber.toString(16).padStart(64, "0")}` as const;
      swept.set(id, { hash, blockNumber, amount, main, wallet });
      return hash;
    },
    sweepEvidence: async (hash, id) => {
      const item = swept.get(id);
      if (!item || item.hash !== hash) throw new Error("missing evidence");
      return item;
    },
    findSweepEvidence: async (id) => swept.get(id),
  };
  return {
    api,
    calls: () => calls,
    debitMain: (amount: bigint) => {
      mainBalance -= amount;
    },
  };
}

function fixture(statePath: string, walletFunding: WalletFundingRail) {
  const deps: GatewayDependencies = {
    authenticateApp: async (request) =>
      request.headers.authorization === "Bearer app" ? "usr_owner" : null,
    walletFunding,
    verifyFundingProof: async (actionHash, proof) =>
      (proof as { action_hash?: string; device_signature?: string })
        .action_hash === actionHash &&
      (proof as { device_signature?: string }).device_signature ===
        "simulated-local-funding",
    recordNumberMatchFailure: async () => {},
    lookupMerchant: async () => null,
    reserveMandate: async () => true,
    releaseMandate: async () => {},
    assessRisk: async () => ({
      result: "deny",
      signals: [],
      explanation: "none",
    }),
    evaluateGuardian: async () => ({
      verdict: "deny",
      reasons: [],
      user_explanation: "none",
    }),
    executePayment: async () => {
      throw new Error("unreachable");
    },
    anchorAudit: async () => `0x${"4".repeat(64)}`,
    signReceipt: async () => "unused",
    statePath,
    stateContext: "funding-test",
  };
  return createGateway(deps, { agents: [], policies: [] });
}

describe("owner funding through app API", () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const run of cleanup.splice(0).reverse()) await run();
  });

  it("returns the denial rule when main funds fall after owner review", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "webank-funding-balance-change-"),
    );
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const chain = rail();
    const app = fixture(join(directory, "gateway.json"), chain.api);
    cleanup.push(async () => app.close());
    const headers = { authorization: "Bearer app" };
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/v1/app/agent-wallet/funding/prepare",
        headers,
        payload: { amount: { amount: 800_000, currency: "CNY" } },
      })
    ).json();
    chain.debitMain(100_000n);
    const denied = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/funding",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        funding_id: challenge.funding_id,
        challenge_id: challenge.challenge_id,
        amount: { amount: 800_000, currency: "CNY" },
        verification: {
          action_hash: challenge.action_hash,
          device_signature: "simulated-local-funding",
        },
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatchObject({
      code: "policy_denied",
      rule: "insufficient_main_funds",
    });
    expect(chain.calls()).toBe(0);
  });

  it("uses confirmed balances, owner proof, chain evidence, and durable idempotency", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-funding-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const statePath = join(directory, "gateway.json");
    const chain = rail();
    let app = fixture(statePath, chain.api);
    cleanup.push(async () => app.close());
    const headers = { authorization: "Bearer app" };
    const denied = await app.inject({ method: "GET", url: "/v1/app/home" });
    expect(denied.statusCode).toBe(401);
    const home = await app.inject({
      method: "GET",
      url: "/v1/app/home",
      headers,
    });
    expect(home.json()).toMatchObject({
      main_account: { balance: { amount: 866_000 } },
      agent_wallet: { balance: { amount: 0 }, available: { amount: 0 } },
      block_number: 1,
    });
    const prepare = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/funding/prepare",
      headers,
      payload: { amount: { amount: 100_000, currency: "CNY" } },
    });
    expect(prepare.statusCode).toBe(200);
    const challenge = prepare.json();
    const body = {
      funding_id: challenge.funding_id,
      challenge_id: challenge.challenge_id,
      amount: { amount: 100_000, currency: "CNY" },
      verification: {
        action_hash: challenge.action_hash,
        device_signature: "simulated-local-funding",
      },
    };
    const agentAttempt = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/funding",
      headers: {
        authorization: "Bearer agent-token",
        "idempotency-key": randomUUID(),
      },
      payload: body,
    });
    expect(agentAttempt.statusCode).toBe(401);
    const badProof = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/funding",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: {
        ...body,
        verification: { ...body.verification, device_signature: "wrong" },
      },
    });
    expect(badProof.statusCode).toBe(401);
    expect(chain.calls()).toBe(0);
    const idem = randomUUID();
    const fund = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/funding",
      headers: { ...headers, "idempotency-key": idem },
      payload: body,
    });
    expect(fund.statusCode).toBe(200);
    expect(fund.json()).toMatchObject({
      schema: "funding.v1",
      status: "completed",
      funding_id: challenge.funding_id,
    });
    expect(chain.calls()).toBe(1);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/funding",
      headers: { ...headers, "idempotency-key": idem },
      payload: body,
    });
    expect(replay.json()).toEqual(fund.json());
    const changed = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/funding",
      headers: { ...headers, "idempotency-key": idem },
      payload: { ...body, amount: { amount: 99_999, currency: "CNY" } },
    });
    expect(changed.statusCode).toBe(409);
    const secondKey = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/funding",
      headers: { ...headers, "idempotency-key": randomUUID() },
      payload: body,
    });
    expect(secondKey.statusCode).toBe(409);
    expect(chain.calls()).toBe(1);
    expect(
      (
        await app.inject({ method: "GET", url: "/v1/app/home", headers })
      ).json(),
    ).toMatchObject({
      main_account: { balance: { amount: 766_000 } },
      agent_wallet: {
        balance: { amount: 100_000 },
        available: { amount: 100_000 },
      },
    });
    await app.close();
    app = fixture(statePath, chain.api);
    const restored = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/funding",
      headers: { ...headers, "idempotency-key": idem },
      payload: body,
    });
    expect(restored.json()).toEqual(fund.json());
    expect(chain.calls()).toBe(1);
    const history = await app.inject({
      method: "GET",
      url: "/v1/app/agent-wallet/funding",
      headers,
    });
    expect(history.json().items).toHaveLength(1);
    const sweepKey = randomUUID();
    const swept = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/sweep",
      headers: { ...headers, "idempotency-key": sweepKey },
      payload: { amount: { amount: 20_000, currency: "CNY" } },
    });
    expect(swept.statusCode).toBe(200);
    expect(swept.json()).toMatchObject({
      status: "completed",
      amount: { amount: 20_000 },
    });
    expect(
      (
        await app.inject({ method: "GET", url: "/v1/app/home", headers })
      ).json(),
    ).toMatchObject({
      main_account: { balance: { amount: 786_000 } },
      agent_wallet: { balance: { amount: 80_000 } },
    });
  });

  it("reconciles an unknown funding result after restart without resubmitting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-funding-uncertain-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const statePath = join(directory, "gateway.json");
    const chain = rail();
    const actualFund = chain.api.fund;
    chain.api.fund = async (id, amount) => {
      await actualFund(id, amount);
      throw new Error("Response lost after bank settlement");
    };
    let app = fixture(statePath, chain.api);
    cleanup.push(async () => app.close());
    const headers = { authorization: "Bearer app" };
    const challenge = (
      await app.inject({
        method: "POST",
        url: "/v1/app/agent-wallet/funding/prepare",
        headers,
        payload: { amount: { amount: 10_000, currency: "CNY" } },
      })
    ).json();
    const key = randomUUID();
    const body = {
      funding_id: challenge.funding_id,
      challenge_id: challenge.challenge_id,
      amount: { amount: 10_000, currency: "CNY" },
      verification: {
        action_hash: challenge.action_hash,
        device_signature: "simulated-local-funding",
      },
    };
    const submitted = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/funding",
      headers: { ...headers, "idempotency-key": key },
      payload: body,
    });
    expect(submitted.statusCode).toBe(503);
    expect(submitted.json().error).toMatchObject({
      code: "reconciliation_required",
      funding_id: challenge.funding_id,
    });
    await app.close();
    app = fixture(statePath, chain.api);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/funding",
      headers: { ...headers, "idempotency-key": key },
      payload: body,
    });
    expect(replay.statusCode).toBe(503);
    expect(chain.calls()).toBe(1);
    const status = await app.inject({
      method: "GET",
      url: `/v1/app/agent-wallet/funding/${challenge.funding_id}`,
      headers,
    });
    expect(status.json()).toMatchObject({
      status: "completed",
      funding_id: challenge.funding_id,
    });
    const restored = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/funding",
      headers: { ...headers, "idempotency-key": key },
      payload: body,
    });
    expect(restored.statusCode).toBe(200);
    expect(chain.calls()).toBe(1);

    const actualSweep = chain.api.sweep;
    chain.api.sweep = async (id, amount) => {
      await actualSweep(id, amount);
      throw new Error("Response lost after sweep settlement");
    };
    const sweepBody = { amount: { amount: 1_000, currency: "CNY" } };
    const sweepKey = randomUUID();
    const unknownSweep = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/sweep",
      headers: { ...headers, "idempotency-key": sweepKey },
      payload: sweepBody,
    });
    expect(unknownSweep.statusCode).toBe(503);
    expect(unknownSweep.json().error.code).toBe("reconciliation_required");
    const unresolvedSweep = await app.inject({
      method: "GET",
      url: "/v1/app/agent-wallet/sweep",
      headers,
    });
    expect(unresolvedSweep.json().items).toMatchObject([
      {
        sweep_id: unknownSweep.json().error.sweep_id,
        status: "reconciliation_required",
      },
    ]);
    await app.close();
    app = fixture(statePath, chain.api);
    const recoveredByRead = await app.inject({
      method: "GET",
      url: `/v1/app/agent-wallet/sweep/${unknownSweep.json().error.sweep_id}`,
      headers,
    });
    expect(recoveredByRead.statusCode).toBe(200);
    expect(recoveredByRead.json()).toMatchObject({
      status: "completed",
      chain: { tx_hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) },
    });
    const recoveredSweep = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/sweep",
      headers: { ...headers, "idempotency-key": sweepKey },
      payload: sweepBody,
    });
    expect(recoveredSweep.statusCode).toBe(200);
    expect(recoveredSweep.json().status).toBe("completed");
    const sweepHistory = await app.inject({
      method: "GET",
      url: "/v1/app/agent-wallet/sweep",
      headers,
    });
    expect(sweepHistory.json().items).toMatchObject([
      { sweep_id: recoveredSweep.json().sweep_id, status: "completed" },
    ]);
    const sweepDetail = await app.inject({
      method: "GET",
      url: `/v1/app/agent-wallet/sweep/${recoveredSweep.json().sweep_id}`,
      headers,
    });
    expect(sweepDetail.json().chain.tx_hash).toBe(
      recoveredSweep.json().chain.tx_hash,
    );
    expect(
      (await app.inject({ method: "GET", url: "/v1/app/agent-wallet/sweep" }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/app/agent-wallet/sweep/${recoveredSweep.json().sweep_id}`,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/app/agent-wallet/sweep/swp_missing",
          headers,
        })
      ).statusCode,
    ).toBe(404);
    const afterSweep = await app.inject({
      method: "GET",
      url: "/v1/app/home",
      headers,
    });
    expect(afterSweep.json()).toMatchObject({
      main_account: { balance: { amount: 857_000 } },
      agent_wallet: { balance: { amount: 9_000 } },
    });
  });
});
