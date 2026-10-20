import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChainAddresses,
  FiscoChain,
  TransactionEvidence,
} from "@webank/chain";
import { ChainRevertError } from "@webank/chain";
import {
  ErrorResponseSchema,
  encodePaymentRequestUri,
} from "@webank/contracts";
import { type Hex, keccak256, stringToHex } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import {
  newAgentKey,
  signAgentRequest,
} from "../../../agents/connector-mcp/src/signing.js";
import { canonicalJson } from "../src/crypto.js";
import { createLocalDemoGateway } from "../src/local-demo.js";
import { createShopPaymentNotifier } from "../src/shop-notifier.js";

const merchantKeys = generateKeyPairSync("ed25519");
const publicKey = `0x${merchantKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`;
const merchant = {
  merchant_id: "mch_shopA",
  ed25519_public_key: publicKey,
  legal_name: "Shop A Electronics (mock)",
  uscc: "MOCK-SHOPA-00000001",
  category: "electronics",
  honeypot: false,
  active: true,
};
const addresses = {
  agentWallet: `0x${"1".repeat(40)}`,
  auditAnchor: `0x${"2".repeat(40)}`,
  ecnySim: `0x${"3".repeat(40)}`,
  merchantRegistry: `0x${"4".repeat(40)}`,
  licenceRegistry: `0x${"5".repeat(40)}`,
} as ChainAddresses;
const demoEnv = {
  NODE_ENV: "test",
  WEBANK_LOCAL_DEMO: "1",
  WEBANK_DEMO_APPROVALS: "1",
};

function fixture(
  callbackFails = false,
  railEvidenceFails = false,
  withHermes = false,
) {
  const evidence = new Map<Hex, TransactionEvidence>();
  const callbacks: Array<{ order_id: string; payment_tx: Hex }> = [];
  const pays: Hex[] = [];
  const hermesRequests: string[] = [];
  let txNumber = 0;
  const transaction = () =>
    `0x${(++txNumber).toString(16).padStart(64, "0")}` as Hex;
  const chain = {
    getMerchant: async () => ({
      payout: `0x${"6".repeat(40)}`,
      signingKey: publicKey,
      legalName: merchant.legal_name,
      uscc: merchant.uscc,
      category: merchant.category,
      active: true,
    }),
    pay: async (
      _address: Hex,
      paymentId: Hex,
      merchantId: Hex,
      amount: bigint,
    ) => {
      const hash = transaction();
      pays.push(hash);
      evidence.set(hash, {
        hash,
        status: "success",
        blockNumber: 1n,
        transactionIndex: 0,
        blockTimestampMs: Date.now(),
        blockTimeIso: new Date().toISOString(),
        paidEvents: [
          {
            paymentId,
            merchantId,
            payout: `0x${"6".repeat(40)}`,
            amount,
          },
        ],
        anchoredEvents: [],
      });
      return hash;
    },
    simulatePay: async () => {},
    anchor: async (
      _address: Hex,
      recordHash: Hex,
      subjectId: Hex,
      kind: number,
    ) => {
      const hash = transaction();
      evidence.set(hash, {
        hash,
        status: "success",
        blockNumber: 1n,
        transactionIndex: 0,
        blockTimestampMs: Date.now(),
        blockTimeIso: new Date().toISOString(),
        paidEvents: [],
        anchoredEvents: [{ recordHash, subjectId, kind, atMs: Date.now() }],
      });
      return hash;
    },
    getTransactionEvidence: async (hash: Hex) => {
      if (railEvidenceFails && pays.includes(hash))
        throw new Error("Rail evidence temporarily unavailable");
      const item = evidence.get(hash);
      if (!item) throw new Error("Unknown transaction");
      return item;
    },
  } as unknown as FiscoChain;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (withHermes && url.startsWith("http://127.0.0.1:54321/v1/")) {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer local-hermes-key",
      );
      hermesRequests.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (url === "http://127.0.0.1:54321/v1/toolsets")
        return Response.json({
          object: "list",
          platform: "api_server",
          data: [
            "terminal",
            "file",
            "browser",
            "web",
            "memory",
            "skills",
            "code_execution",
            "delegation",
          ].map((name) => ({
            name,
            enabled: false,
            configured: false,
            tools: [name],
          })),
        });
      if (url === "http://127.0.0.1:54321/v1/chat/completions")
        return Response.json({
          object: "chat.completion",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({
                  verdict: "pass",
                  reason_code: "none",
                  reasons: ["The signed item matches the locked intent"],
                  user_explanation: "The signed item matches your request.",
                }),
              },
            },
          ],
        });
    }
    if (url === "http://127.0.0.1:3001/api/merchants")
      return Response.json({ simulated: true, merchants: [merchant] });
    if (url === "http://127.0.0.1:3001/internal/drill-visibility") {
      const body = JSON.parse(String(init?.body)) as { enabled: boolean };
      expect(init?.headers).toMatchObject({
        authorization: "Bearer local-token",
      });
      return Response.json({ drill_visible: body.enabled });
    }
    if (url === "http://127.0.0.1:3001/internal/payment-confirmed") {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer local-token",
      });
      expect(pays).toHaveLength(1);
      const body = JSON.parse(String(init?.body)) as {
        order_id: string;
        payment_tx: Hex;
      };
      callbacks.push(body);
      if (callbackFails)
        return Response.json({ error: "shop unavailable" }, { status: 503 });
      return Response.json({ ...body, status: "paid" });
    }
    throw new Error(`Unexpected shop request: ${url}`);
  }) as typeof fetch;
  return { chain, fetcher, callbacks, pays, hermesRequests };
}

function signedPayreq() {
  const unsigned = {
    schema: "payreq.v1" as const,
    merchant_id: merchant.merchant_id,
    order_id: `ord_${randomUUID().replaceAll("-", "")}`,
    amount: { amount: 27_900, currency: "CNY" as const },
    line_items: [
      {
        type: "product" as const,
        sku: "NOVA-Q3-BLK",
        gtin: "6901234567001",
        name: "Nova Quiet 3",
        condition: "new" as const,
        variant: "Black",
        options: { colour: "Black", size: "One size" },
        qty: 1,
        unit_price: { amount: 27_900, currency: "CNY" as const },
      },
      {
        type: "shipping" as const,
        name: "Shipping",
        qty: 1 as const,
        unit_price: { amount: 0, currency: "CNY" as const },
      },
    ],
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    nonce: randomUUID(),
  };
  return encodePaymentRequestUri({
    ...unsigned,
    merchant_sig: sign(
      null,
      Buffer.from(canonicalJson(unsigned)),
      merchantKeys.privateKey,
    ).toString("base64url"),
  });
}

describe("loopback FISCO demo composition", () => {
  const apps: Array<Awaited<ReturnType<typeof createLocalDemoGateway>>["app"]> =
    [];
  const temporaryDirs: string[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const directory of temporaryDirs.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  async function makeApp(
    callbackFails = false,
    statePath?: string,
    railEvidenceFails = false,
    withHermes = false,
    hermesVerified = false,
  ) {
    const fixtureData = fixture(callbackFails, railEvidenceFails, withHermes);
    const trustBank = {
      fund: async () => {
        throw new Error("unused funding");
      },
      sweep: async () => {
        throw new Error("unused sweep");
      },
      payFromMain: async () => {
        throw new Error("unused main payment");
      },
      setTrustLight: async () => `0x${"a".repeat(64)}` as Hex,
    };
    const result = await createLocalDemoGateway({
      chain: fixtureData.chain,
      addresses,
      merchants: [merchant],
      shopOrigin: "http://127.0.0.1:3001",
      appOrigin: "http://127.0.0.1:8081",
      gatewayOrigin: "http://127.0.0.1:3002",
      shopToken: "local-token",
      fetcher: fixtureData.fetcher,
      env: withHermes
        ? {
            ...demoEnv,
            WEBANK_GUARDIAN_HERMES_URL: "http://127.0.0.1:54321",
            WEBANK_GUARDIAN_HERMES_KEY: "local-hermes-key",
            WEBANK_GUARDIAN_HERMES_PROFILE_VERIFIED: hermesVerified ? "1" : "0",
          }
        : demoEnv,
      statePath,
      bankExecutor: trustBank,
    });
    apps.push(result.app);
    return { ...result, ...fixtureData, trustBank };
  }

  it("requires both opt-ins, loopback origins, and matching shop identity", async () => {
    const data = fixture();
    const base = {
      chain: data.chain,
      addresses,
      merchants: [merchant],
      shopOrigin: "http://127.0.0.1:3001",
      appOrigin: "http://127.0.0.1:8081",
      gatewayOrigin: "http://127.0.0.1:3002",
      shopToken: "local-token",
      fetcher: data.fetcher,
    };
    await expect(
      createLocalDemoGateway({
        ...base,
        env: { ...demoEnv, NODE_ENV: "production" },
      }),
    ).rejects.toThrow("outside production");
    await expect(
      createLocalDemoGateway({
        ...base,
        env: { ...demoEnv, WEBANK_DEMO_APPROVALS: "0" },
      }),
    ).rejects.toThrow("outside production");
    await expect(
      createLocalDemoGateway({
        ...base,
        shopOrigin: "http://localhost:3001",
        env: demoEnv,
      }),
    ).rejects.toThrow("127.0.0.1");
    await expect(
      createLocalDemoGateway({
        ...base,
        merchants: [{ ...merchant, ed25519_public_key: `0x${"0".repeat(64)}` }],
        env: demoEnv,
      }),
    ).rejects.toThrow("Merchant identity mismatch");
  });

  it.each([
    ["paid", false, false],
    ["callback unavailable", true, false],
    ["rail evidence unavailable", false, true],
  ] as const)(
    "pairs and retains payment outcome across restart; %s",
    async (_case, callbackFails, railEvidenceFails) => {
      const directory = mkdtempSync(join(tmpdir(), "webank-gateway-restart-"));
      temporaryDirs.push(directory);
      const statePath = join(directory, "gateway.json");
      const {
        app,
        loginToken,
        receiptPublicKey,
        chain,
        fetcher,
        callbacks,
        pays,
        hermesRequests,
        trustBank,
      } = await makeApp(
        callbackFails,
        statePath,
        railEvidenceFails,
        _case !== "rail evidence unavailable",
        _case === "paid",
      );
      const login = await app.inject({
        method: "POST",
        url: "/demo/login",
        headers: { authorization: `Bearer ${loginToken}` },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json()).toMatchObject({ simulated: true });
      const cookie = login.headers["set-cookie"] as string;
      const appHeaders = { cookie, "idempotency-key": randomUUID() };
      const key = newAgentKey();
      const pairing = await app.inject({
        method: "POST",
        url: "/v1/oauth/device_authorization",
        payload: {
          client_name: "Local Claude",
          provider: "anthropic",
          client_app_name: "Claude Code",
          client_app_id: `app_${createHash("sha256").update("Claude Code").digest("hex")}`,
          agent_public_key: key.publicKey,
          requested_scopes: [
            "wallet:pay",
            "wallet:mandate",
            "wallet:history:self",
          ],
        },
      });
      expect(pairing.statusCode).toBe(200);
      const pair = pairing.json();
      const pairCard = await app.inject({
        method: "GET",
        url: `/v1/app/pairing/${pair.user_code}`,
        headers: appHeaders,
      });
      const paired = await app.inject({
        method: "POST",
        url: `/v1/app/pairing/${pair.user_code}/approve`,
        headers: appHeaders,
        payload: {
          verification: {
            action_hash: pairCard.json().approval.payload_hash,
            device_signature: "simulated-local-approval",
            request_number: pair.request_number,
          },
        },
      });
      expect(paired.statusCode).toBe(200);
      const token = await app.inject({
        method: "POST",
        url: "/v1/oauth/token",
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: pair.device_code,
        },
      });
      expect(token.statusCode).toBe(200);
      const auth = token.json();
      async function agentPost(path: string, body: unknown) {
        const json = JSON.stringify(body);
        return app.inject({
          method: "POST",
          url: path,
          headers: {
            ...signAgentRequest({
              method: "POST",
              path,
              body: json,
              idempotencyKey: randomUUID(),
              agentId: auth.agent_id,
              privateKeyPem: key.privateKeyPem,
            }),
            authorization: `Bearer ${auth.access_token}`,
            "content-type": "application/json",
          },
          payload: json,
        });
      }
      const mandate = await agentPost("/v1/agent/mandates", {
        description: "Buy Nova headphones under 300 CNY",
        approval_timing: "upfront",
        user_text: "Buy Nova headphones under 300 CNY",
        intent_level: "open",
        constraints: [
          { type: "amount_range", max: { amount: 30_000, currency: "CNY" } },
          { type: "categories", allowed: ["electronics"] },
          { type: "budget", max: { amount: 30_000, currency: "CNY" } },
          { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
          {
            type: "execution_window",
            not_before: null,
            not_after: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
      });
      expect(mandate.statusCode).toBe(202);
      const pendingMandate = await app.inject({
        method: "GET",
        url: "/v1/app/approvals",
        headers: appHeaders,
      });
      const mandateCard = pendingMandate
        .json()
        .items.find(
          (item: { subject_id: string }) =>
            item.subject_id === mandate.json().mandate.mandate_id,
        );
      const mandateApproval = await app.inject({
        method: "POST",
        url: `/v1/app/approvals/${mandateCard.approval_id}/decide`,
        headers: { cookie, "idempotency-key": randomUUID() },
        payload: {
          decision: "approve",
          verification: {
            action_hash: mandateCard.payload_hash,
            device_signature: "simulated-local-approval",
            request_number: mandate.json().request_number,
          },
        },
      });
      expect(mandateApproval.statusCode).toBe(200);
      expect(mandateApproval.json().mandate.approved_by).toBe(
        "demo_simulation",
      );
      const payment = await agentPost("/v1/agent/payments", {
        mandate_id: mandate.json().mandate.mandate_id,
        payment_request: signedPayreq(),
        price_evidence: [],
        rationale: "Untrusted agent claim",
      });
      expect(payment.statusCode).toBe(202);
      if (_case === "paid") {
        expect(hermesRequests).toEqual([
          "GET /v1/toolsets",
          "POST /v1/chat/completions",
        ]);
        expect(
          payment
            .json()
            .decision.checks.find(
              (check: { name: string }) => check.name === "guardian",
            ).result,
        ).toBe("pass");
      } else if (_case === "callback unavailable") {
        expect(hermesRequests).toEqual([]);
        const guardian = payment
          .json()
          .decision.checks.find(
            (check: { name: string }) => check.name === "guardian",
          );
        expect(guardian.result).toBe("step_up");
        expect(guardian.detail.reason).toBe("guardian_unavailable");
      }
      const pendingPayment = await app.inject({
        method: "GET",
        url: "/v1/app/approvals",
        headers: appHeaders,
      });
      const paymentCard = pendingPayment
        .json()
        .items.find(
          (item: { subject_id: string }) =>
            item.subject_id === payment.json().payment_id,
        );
      const approveHeaders = { cookie, "idempotency-key": randomUUID() };
      const decision = await app.inject({
        method: "POST",
        url: `/v1/app/approvals/${paymentCard.approval_id}/decide`,
        headers: approveHeaders,
        payload: {
          decision: "approve",
          verification: {
            action_hash: paymentCard.payload_hash,
            device_signature: "simulated-local-approval",
            request_number: payment.json().request_number,
          },
        },
      });
      expect(pays).toHaveLength(1);
      expect(callbacks).toHaveLength(railEvidenceFails ? 0 : 1);
      if (!railEvidenceFails) expect(callbacks[0]?.payment_tx).toBe(pays[0]);
      if (callbackFails || railEvidenceFails) {
        expect(decision.statusCode).toBe(503);
        expect(decision.json().error).toMatchObject({
          code: "reconciliation_required",
          payment_id: payment.json().payment_id,
          ...(railEvidenceFails ? {} : { payment_tx: pays[0] }),
        });
        expect(() => ErrorResponseSchema.parse(decision.json())).not.toThrow();
        const status = await app.inject({
          method: "GET",
          url: `/v1/app/payments/${payment.json().payment_id}`,
          headers: appHeaders,
        });
        expect(status.statusCode).toBe(503);
        expect(status.json().error.payment_tx).toBe(
          railEvidenceFails ? undefined : pays[0],
        );
        const repeated = await app.inject({
          method: "POST",
          url: `/v1/app/approvals/${paymentCard.approval_id}/decide`,
          headers: approveHeaders,
          payload: {
            decision: "approve",
            verification: {
              action_hash: paymentCard.payload_hash,
              device_signature: "simulated-local-approval",
              request_number: payment.json().request_number,
            },
          },
        });
        expect(repeated.statusCode).toBe(503);
        const freshRetry = await app.inject({
          method: "POST",
          url: `/v1/app/approvals/${paymentCard.approval_id}/decide`,
          headers: { cookie, "idempotency-key": randomUUID() },
          payload: {
            decision: "approve",
            verification: {
              action_hash: paymentCard.payload_hash,
              device_signature: "simulated-local-approval",
              request_number: payment.json().request_number,
            },
          },
        });
        expect(freshRetry.statusCode).toBe(503);
        expect(freshRetry.json().error.payment_tx).toBe(
          railEvidenceFails ? undefined : pays[0],
        );
        expect(pays).toHaveLength(1);
        expect(callbacks).toHaveLength(railEvidenceFails ? 0 : 1);
      } else {
        expect(decision.statusCode).toBe(200);
        expect(decision.json().payment.status).toBe("paid");
        expect(decision.json().payment.receipt.chain.payment_tx).toBe(pays[0]);
      }
      const firstReceipt =
        callbackFails || railEvidenceFails
          ? null
          : decision.json().payment.receipt;
      await app.close();
      apps.splice(apps.indexOf(app), 1);
      const restarted = await createLocalDemoGateway({
        chain,
        addresses,
        merchants: [merchant],
        shopOrigin: "http://127.0.0.1:3001",
        appOrigin: "http://127.0.0.1:8081",
        gatewayOrigin: "http://127.0.0.1:3002",
        shopToken: "local-token",
        fetcher,
        env: demoEnv,
        statePath,
        bankExecutor: trustBank,
      });
      apps.push(restarted.app);
      expect(restarted.loginToken).toBe(loginToken);
      expect(
        restarted.receiptPublicKey.export({ format: "der", type: "spki" }),
      ).toEqual(receiptPublicKey.export({ format: "der", type: "spki" }));
      expect(statSync(statePath).mode & 0o077).toBe(0);
      expect(statSync(statePath).size).toBeLessThan(1_000_000);
      const restoredAgents = await restarted.app.inject({
        method: "GET",
        url: "/v1/app/agents",
        headers: appHeaders,
      });
      expect(restoredAgents.statusCode).toBe(200);
      expect(restoredAgents.json().items).toHaveLength(1);
      const restoredPairing = await restarted.app.inject({
        method: "GET",
        url: "/v1/app/pairings",
        headers: appHeaders,
      });
      expect(restoredPairing.statusCode).toBe(200);
      expect(
        restoredPairing
          .json()
          .items.find(
            (item: { user_code: string }) => item.user_code === pair.user_code,
          )?.status,
      ).toBe("approved");
      const restoredPayment = await restarted.app.inject({
        method: "GET",
        url: `/v1/app/payments/${payment.json().payment_id}`,
        headers: appHeaders,
      });
      expect(restoredPayment.statusCode).toBe(
        callbackFails || railEvidenceFails ? 503 : 200,
      );
      if (!callbackFails && !railEvidenceFails) {
        expect(restoredPayment.json().receipt).toEqual(firstReceipt);
        const { webank_sig, ...unsigned } = firstReceipt;
        expect(
          verify(
            null,
            Buffer.from(canonicalJson(unsigned)),
            restarted.receiptPublicKey,
            Buffer.from(webank_sig, "base64url"),
          ),
        ).toBe(true);
      }
      const replayAfterRestart = await restarted.app.inject({
        method: "POST",
        url: `/v1/app/approvals/${paymentCard.approval_id}/decide`,
        headers: approveHeaders,
        payload: {
          decision: "approve",
          verification: {
            action_hash: paymentCard.payload_hash,
            device_signature: "simulated-local-approval",
            request_number: payment.json().request_number,
          },
        },
      });
      expect(replayAfterRestart.statusCode).toBe(
        callbackFails || railEvidenceFails ? 503 : 200,
      );
      expect(pays).toHaveLength(1);
    },
  );

  it("funds an empty active wallet, enforces chain-backed holds, pays from wallet, and sweeps only available funds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-active-funding-"));
    temporaryDirs.push(directory);
    const statePath = join(directory, "gateway.json");
    const data = fixture();
    const activeAddresses = {
      ...addresses,
      bank: `0x${"9".repeat(40)}` as Hex,
      migration: { state: "active" },
    };
    let mainBalance = 866_000n;
    let walletBalance = 0n;
    let blockNumber = 1n;
    const funding = new Map<
      string,
      { hash: Hex; amount: bigint; blockNumber: bigint; main: Hex; wallet: Hex }
    >();
    const sweeps = new Map<
      string,
      { hash: Hex; amount: bigint; blockNumber: bigint; main: Hex; wallet: Hex }
    >();
    let fundingCalls = 0;
    const trustWrites: number[] = [];
    const tx = () =>
      `0x${(++blockNumber).toString(16).padStart(64, "0")}` as Hex;
    const bankExecutor = {
      setCaps: async () => tx(),
      setTrustLight: async (_intentId: string, level: number) => {
        trustWrites.push(level);
        return tx();
      },
      fund: async (id: string, amount: bigint) => {
        fundingCalls++;
        if (mainBalance < amount)
          throw new ChainRevertError("insufficient main");
        mainBalance -= amount;
        walletBalance += amount;
        const hash = tx();
        funding.set(id, {
          hash,
          amount,
          blockNumber,
          main: activeAddresses.bank,
          wallet: activeAddresses.agentWallet,
        });
        return hash;
      },
      sweep: async (id: string, amount: bigint) => {
        if (walletBalance < amount) throw new ChainRevertError("insufficient");
        walletBalance -= amount;
        mainBalance += amount;
        const hash = tx();
        sweeps.set(id, {
          hash,
          amount,
          blockNumber,
          main: activeAddresses.bank,
          wallet: activeAddresses.agentWallet,
        });
        return hash;
      },
    };
    const originalPay = data.chain.pay.bind(data.chain);
    Object.assign(data.chain, {
      getPolicyCapsSnapshot: async () => ({
        perPaymentCap: 30_000n,
        dailyCap: 50_000n,
        monthlyCap: 100_000n,
        spentToday: 0n,
        spentMonth: 0n,
        blockNumber,
        observedAt: new Date().toISOString(),
        nextDailyResetAt: new Date(Date.now() + 86_400_000).toISOString(),
        nextMonthlyResetAt: new Date(Date.now() + 2_592_000_000).toISOString(),
      }),
      getWalletSnapshot: async () => ({
        mainBalance,
        walletBalance,
        walletFrozen: false,
        blockNumber,
        observedAt: new Date().toISOString(),
      }),
      isFundingApplied: async (_token: Hex, id: Hex) =>
        [...funding.keys()].some((key) => keccak256(stringToHex(key)) === id),
      getFundingEvidence: async (hash: Hex, _token: Hex, id: Hex) => {
        const value = [...funding].find(
          ([key, item]) =>
            keccak256(stringToHex(key)) === id && item.hash === hash,
        )?.[1];
        if (!value) throw new Error("missing Funded");
        return { ...value, token: activeAddresses.ecnySim, fundingId: id };
      },
      findFundingEvidence: async (_token: Hex, id: Hex) => {
        const value = [...funding].find(
          ([key]) => keccak256(stringToHex(key)) === id,
        )?.[1];
        return value
          ? { ...value, token: activeAddresses.ecnySim, fundingId: id }
          : undefined;
      },
      getSweepEvidence: async (hash: Hex, _wallet: Hex, id: Hex) => {
        const value = [...sweeps].find(
          ([key, item]) =>
            keccak256(stringToHex(key)) === id && item.hash === hash,
        )?.[1];
        if (!value) throw new Error("missing Swept");
        return { ...value, token: activeAddresses.ecnySim, sweepId: id };
      },
      findSweepEvidence: async (_wallet: Hex, id: Hex) => {
        const value = [...sweeps].find(
          ([key]) => keccak256(stringToHex(key)) === id,
        )?.[1];
        return value
          ? { ...value, token: activeAddresses.ecnySim, sweepId: id }
          : undefined;
      },
      pay: async (
        walletAddress: Hex,
        paymentId: Hex,
        merchantId: Hex,
        amount: bigint,
      ) => {
        if (walletBalance < amount) throw new ChainRevertError("insufficient");
        const hash = await originalPay(
          walletAddress,
          paymentId,
          merchantId,
          amount,
        );
        walletBalance -= amount;
        return hash;
      },
    });
    const options = {
      chain: data.chain,
      addresses: activeAddresses,
      bankExecutor,
      merchants: [merchant],
      shopOrigin: "http://127.0.0.1:3001",
      appOrigin: "http://127.0.0.1:8081",
      gatewayOrigin: "http://127.0.0.1:3002",
      shopToken: "local-token",
      fetcher: data.fetcher,
      env: demoEnv,
      statePath,
    };
    const { app, loginToken } = await createLocalDemoGateway(options);
    apps.push(app);
    const login = await app.inject({
      method: "POST",
      url: "/demo/login",
      headers: { authorization: `Bearer ${loginToken}` },
    });
    const cookie = login.headers["set-cookie"] as string;
    const appHeaders = { cookie, "idempotency-key": randomUUID() };
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/app/home",
          headers: appHeaders,
        })
      ).json(),
    ).toMatchObject({
      main_account: { balance: { amount: 866_000 } },
      agent_wallet: { balance: { amount: 0 }, available: { amount: 0 } },
    });
    const key = newAgentKey();
    const pairing = (
      await app.inject({
        method: "POST",
        url: "/v1/oauth/device_authorization",
        payload: {
          client_name: "Local Claude",
          provider: "anthropic",
          client_app_name: "Claude Code",
          client_app_id: `app_${createHash("sha256").update("Claude Code").digest("hex")}`,
          agent_public_key: key.publicKey,
          requested_scopes: [
            "wallet:pay",
            "wallet:mandate",
            "wallet:history:self",
          ],
        },
      })
    ).json();
    const pairCard = (
      await app.inject({
        method: "GET",
        url: `/v1/app/pairing/${pairing.user_code}`,
        headers: appHeaders,
      })
    ).json().approval;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/app/pairing/${pairing.user_code}/approve`,
          headers: appHeaders,
          payload: {
            verification: {
              action_hash: pairCard.payload_hash,
              device_signature: "simulated-local-approval",
              request_number: pairing.request_number,
            },
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(trustWrites).toEqual([1]);
    const auth = (
      await app.inject({
        method: "POST",
        url: "/v1/oauth/token",
        payload: {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: pairing.device_code,
        },
      })
    ).json();
    const agentPost = async (path: string, body: unknown) => {
      const json = JSON.stringify(body);
      return app.inject({
        method: "POST",
        url: path,
        headers: {
          ...signAgentRequest({
            method: "POST",
            path,
            body: json,
            idempotencyKey: randomUUID(),
            agentId: auth.agent_id,
            privateKeyPem: key.privateKeyPem,
          }),
          authorization: `Bearer ${auth.access_token}`,
          "content-type": "application/json",
        },
        payload: json,
      });
    };
    const mandateBody = (budget: number) => ({
      description: "Buy Nova headphones",
      approval_timing: "upfront",
      user_text: "Buy Nova headphones",
      intent_level: "open",
      constraints: [
        { type: "amount_range", max: { amount: 30_000, currency: "CNY" } },
        { type: "categories", allowed: ["electronics"] },
        { type: "budget", max: { amount: budget, currency: "CNY" } },
        { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
        {
          type: "execution_window",
          not_before: null,
          not_after: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
    });
    const unfunded = await agentPost("/v1/agent/mandates", mandateBody(30_000));
    expect(unfunded.statusCode).toBe(403);
    expect(unfunded.json().error.rule).toBe("insufficient_reserved_funds");
    const deniedMandates = await app.inject({
      method: "GET",
      url: "/v1/app/mandates",
      headers: appHeaders,
    });
    expect(deniedMandates.json().items).toEqual([]);
    const deniedApprovals = await app.inject({
      method: "GET",
      url: "/v1/app/approvals",
      headers: appHeaders,
    });
    expect(deniedApprovals.json().items).toEqual([]);
    const prepared = (
      await app.inject({
        method: "POST",
        url: "/v1/app/agent-wallet/funding/prepare",
        headers: appHeaders,
        payload: { amount: { amount: 100_000, currency: "CNY" } },
      })
    ).json();
    const funded = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/funding",
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: {
        funding_id: prepared.funding_id,
        challenge_id: prepared.challenge_id,
        amount: { amount: 100_000, currency: "CNY" },
        verification: {
          action_hash: prepared.action_hash,
          device_signature: "simulated-local-funding",
        },
      },
    });
    expect(funded.statusCode).toBe(200);
    expect(fundingCalls).toBe(1);
    const fundedMandate = await agentPost(
      "/v1/agent/mandates",
      mandateBody(30_000),
    );
    expect(fundedMandate.statusCode).toBe(202);
    const fundedCard = (
      await app.inject({
        method: "GET",
        url: "/v1/app/approvals",
        headers: appHeaders,
      })
    )
      .json()
      .items.find(
        (item: { subject_id: string }) =>
          item.subject_id === fundedMandate.json().mandate.mandate_id,
      );
    const fundedApproval = await app.inject({
      method: "POST",
      url: `/v1/app/approvals/${fundedCard.approval_id}/decide`,
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: {
        decision: "approve",
        verification: {
          action_hash: fundedCard.payload_hash,
          device_signature: "simulated-local-approval",
          request_number: fundedMandate.json().request_number,
        },
      },
    });
    expect(fundedApproval.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/app/home",
          headers: appHeaders,
        })
      ).json(),
    ).toMatchObject({
      main_account: { balance: { amount: 766_000 } },
      agent_wallet: {
        balance: { amount: 100_000 },
        reserved: { amount: 30_000 },
        available: { amount: 70_000 },
      },
    });
    const overSweep = await app.inject({
      method: "POST",
      url: "/v1/app/agent-wallet/sweep",
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: { amount: { amount: 70_001, currency: "CNY" } },
    });
    expect(overSweep.statusCode).toBe(403);
    expect(overSweep.json().error.rule).toBe("insufficient_wallet_funds");
    const payment = await agentPost("/v1/agent/payments", {
      mandate_id: fundedMandate.json().mandate.mandate_id,
      payment_request: signedPayreq(),
      price_evidence: [],
      rationale: "Untrusted agent claim",
    });
    expect(payment.statusCode).toBe(202);
    const paymentCard = (
      await app.inject({
        method: "GET",
        url: "/v1/app/approvals",
        headers: appHeaders,
      })
    )
      .json()
      .items.find(
        (item: { subject_id: string }) =>
          item.subject_id === payment.json().payment_id,
      );
    const decision = await app.inject({
      method: "POST",
      url: `/v1/app/approvals/${paymentCard.approval_id}/decide`,
      headers: { cookie, "idempotency-key": randomUUID() },
      payload: {
        decision: "approve",
        verification: {
          action_hash: paymentCard.payload_hash,
          device_signature: "simulated-local-approval",
          request_number: payment.json().request_number,
        },
      },
    });
    expect(decision.statusCode).toBe(200);
    expect(data.pays).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/app/home",
          headers: appHeaders,
        })
      ).json(),
    ).toMatchObject({
      main_account: { balance: { amount: 766_000 } },
      agent_wallet: { balance: { amount: 72_100 }, reserved: { amount: 0 } },
    });
    const orphan = await agentPost("/v1/agent/mandates", mandateBody(10_000));
    expect(orphan.statusCode).toBe(202);
    const ownerRevokeKey = randomUUID();
    const ownerRevoke = await app.inject({
      method: "POST",
      url: `/v1/app/agents/${auth.agent_id}/revoke`,
      headers: { cookie, "idempotency-key": ownerRevokeKey },
      payload: { confirmation_agent_id: auth.agent_id },
    });
    expect(ownerRevoke.statusCode).toBe(200);
    const ownerRevokeReplay = await app.inject({
      method: "POST",
      url: `/v1/app/agents/${auth.agent_id}/revoke`,
      headers: { cookie, "idempotency-key": ownerRevokeKey },
      payload: { confirmation_agent_id: auth.agent_id },
    });
    expect(ownerRevokeReplay.json()).toEqual(ownerRevoke.json());
    const mandatesAfterRevoke = await app.inject({
      method: "GET",
      url: "/v1/app/mandates",
      headers: appHeaders,
    });
    expect(
      mandatesAfterRevoke
        .json()
        .items.find(
          (item: { mandate_id: string }) =>
            item.mandate_id === orphan.json().mandate.mandate_id,
        )?.status,
    ).toBe("cancelled");
    const approvalsAfterRevoke = await app.inject({
      method: "GET",
      url: "/v1/app/approvals",
      headers: appHeaders,
    });
    expect(
      approvalsAfterRevoke
        .json()
        .items.find(
          (item: { subject_id: string }) =>
            item.subject_id === orphan.json().mandate.mandate_id,
        )?.status,
    ).toBe("rejected");
  });
});

describe("shop callback adapter", () => {
  it("rejects redirect and mismatched confirmation", async () => {
    expect(() =>
      createShopPaymentNotifier({
        shopOrigin: "https://example.com",
        internalToken: "secret",
      }),
    ).toThrow("127.0.0.1");
    const notifier = createShopPaymentNotifier({
      shopOrigin: "http://127.0.0.1:3001",
      internalToken: "secret",
      fetcher: (async () =>
        Response.json({
          order_id: "wrong",
          status: "paid",
          payment_tx: `0x${"1".repeat(64)}`,
        })) as typeof fetch,
    });
    await expect(
      notifier({ orderId: "ord_test", paymentTx: `0x${"1".repeat(64)}` }),
    ).rejects.toThrow("did not match");
  });
});
