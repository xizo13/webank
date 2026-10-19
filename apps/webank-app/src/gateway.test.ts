import { describe, expect, it, vi } from "vitest";
import type { Approval } from "./flow";
import {
  createGatewayClient,
  GatewayRequestError,
  gatewaySnapshotErrorMessage,
  isLoopbackLocalDemo,
} from "./gateway";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("Gateway app client", () => {
  const approval = (kind: Approval["kind"] = "payment"): Approval => ({
    approval_id: "apr_local",
    kind,
    subject_id: kind === "pairing" ? "ABCD-EFGH" : "pay_local",
    title: "Review local request",
    lines: ["Simulated local Gateway"],
    payload_hash: `sha256:${"a".repeat(64)}`,
    level: "zero_trust",
    expires_at: new Date(Date.now() + 180_000).toISOString(),
    status: "pending",
  });

  it("loads live agents, pending approvals, and payment history without exposing connector numbers", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/app/agents")
        return json({ items: [{ agent_id: "agt_one", status: "active" }] });
      if (path === "/v1/app/pairings") return json({ items: [] });
      if (path === "/v1/app/approvals")
        return json({
          items: [
            {
              approval_id: "apr_one",
              status: "pending",
              title: "Pay Shop A",
              lines: ["¥279.00"],
            },
            {
              approval_id: "apr_old",
              status: "expired",
              title: "Old",
              lines: ["Expired"],
            },
          ],
        });
      if (path === "/v1/app/payments")
        return json({
          items: [
            {
              payment_id: "pay_one",
              status: "paid",
              amount: { amount: 27900, currency: "CNY" },
              merchant: "Shop A",
              created_at: "2026-10-14T12:00:00Z",
            },
          ],
        });
      if (path === "/v1/app/pairing/ABCD-EFGH")
        return json({
          approval: {
            approval_id: "apr_pair",
            kind: "pairing",
            title: "Connect",
            lines: ["Claude asks for access"],
          },
          client_name: "Claude",
          provider: "Anthropic",
          requested_scopes: ["wallet:pay"],
          public_key: "test-key",
        });
      throw new Error(`Unexpected path ${path}`);
    }) as unknown as typeof fetch;
    const client = createGatewayClient("http://127.0.0.1:8787/", fetcher);
    const snapshot = await client.snapshot();
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.approvals.map((approval) => approval.approval_id)).toEqual([
      "apr_one",
    ]);
    expect(snapshot.payments[0]?.amount.amount).toBe(27900);
    expect(snapshot.pairings).toEqual([]);
    const consent = await client.pairing("ABCD-EFGH");
    expect(consent.approval.title).toBe("Connect");
    expect(JSON.stringify(consent)).not.toContain("request_number");
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/v1/app/pairing/ABCD-EFGH"),
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("reads independent pairing details from the consent summary", async () => {
    const pairing = {
      user_code: "ABCD-EFGH",
      client_name: "Claude personal shopper",
      provider: "Anthropic",
      requested_scopes: ["wallet:pay", "wallet:mandate"],
      status: "pending",
      expires_at: "2099-01-01T00:00:00Z",
      request_number_expires_at: "2099-01-01T00:00:00Z",
    };
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/app/pairing/ABCD-EFGH")
        return json({
          approval: approval("pairing"),
          pairing,
          public_key: "test-key",
          replacement_candidates: [],
        });
      throw new Error(`Unexpected path ${path}`);
    }) as unknown as typeof fetch;
    const client = createGatewayClient("http://127.0.0.1:8787", fetcher);
    const consent = await client.pairing(pairing.user_code);
    expect(consent.pairing.client_name).toBe("Claude personal shopper");
    expect(consent.pairing.provider).toBe("Anthropic");
    expect(consent.pairing.requested_scopes.join(", ")).toBe(
      "wallet:pay, wallet:mandate",
    );
    expect(consent).not.toHaveProperty("requested_scopes");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("explains an expired pairing number without treating it as a wrong attempt", async () => {
    const client = createGatewayClient(
      "http://127.0.0.1:8787",
      vi.fn(async () =>
        json({ error: { code: "request_number_expired" } }, 409),
      ) as unknown as typeof fetch,
      true,
    );
    await expect(
      client.approveSimulated(approval("pairing"), "123456", "ABCD-EFGH"),
    ).rejects.toMatchObject({
      status: 409,
      code: "request_number_expired",
      message: expect.stringContaining("refreshed number"),
    });
  });

  it("sends idempotent deny, reject, and freeze requests, and loads a receipt", async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ path: new URL(String(input)).pathname, init: init ?? {} });
        if (String(input).endsWith("/payments/pay_one"))
          return json({
            payment_id: "pay_one",
            status: "denied",
            decision: { outcome: "DENIED" },
            receipt: { receipt_id: "rcp_one", outcome: "DENIED" },
          });
        return json({
          agent: { status: "frozen" },
          approval: { status: "rejected" },
        });
      },
    ) as unknown as typeof fetch;
    const client = createGatewayClient("http://127.0.0.1:8787", fetcher);
    await client.denyPairing("ABCD-EFGH");
    await client.rejectApproval("apr_one");
    await client.freezeAgent("agt_one");
    const receipt = await client.payment("pay_one");
    expect(receipt.receipt?.outcome).toBe("DENIED");
    expect(calls.slice(0, 3).map((call) => call.path)).toEqual([
      "/v1/app/pairing/ABCD-EFGH/deny",
      "/v1/app/approvals/apr_one/decide",
      "/v1/app/agents/agt_one/freeze",
    ]);
    for (const call of calls.slice(0, 3)) {
      expect(call.init.method).toBe("POST");
      expect(
        new Headers(call.init.headers).get("Idempotency-Key"),
      ).toBeTruthy();
    }
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      decision: "reject",
    });
  });

  it("prepares simulated owner recovery, reads history, and confirms Delete by agent ID", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        calls.push({ path, init: init ?? {} });
        if (path.endsWith("/prepare-action"))
          return json({
            action_hash: "sha256:action",
            challenge_id: "chg_one",
            expires_at: "2099-01-01T00:00:00Z",
            agent_summary: {},
          });
        if (path.endsWith("/history"))
          return json({
            root_agent_id: "agt_old",
            items: [
              {
                kind: "freeze",
                summary: "User froze agent",
                created_at: "2026-10-15T00:00:00Z",
              },
            ],
          });
        return json({
          agent: { agent_id: "agt_old", status: "revoked" },
          simulated: true,
        });
      },
    ) as unknown as typeof fetch;
    const client = createGatewayClient("http://127.0.0.1:8787", fetcher, true);
    const challenge = await client.prepareAgentAction("agt_old", "unfreeze");
    await client.agentHistory("agt_old");
    await client.completeSimulatedAgentAction("agt_old", "unfreeze", challenge);
    await client.deleteAgent("agt_old");
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/app/agents/agt_old/prepare-action",
      "/v1/app/agents/agt_old/history",
      "/v1/app/agents/agt_old/unfreeze",
      "/v1/app/agents/agt_old/revoke",
    ]);
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      challenge_id: "chg_one",
      verification: {
        action_hash: "sha256:action",
        device_signature: "simulated-local-approval",
      },
    });
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({
      confirmation_agent_id: "agt_old",
    });
  });

  it("reports offline and expired-session errors while preserving caller state", async () => {
    const offline = createGatewayClient(
      "http://127.0.0.1:8787",
      vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    );
    await expect(offline.snapshot()).rejects.toThrow("Gateway is offline");
    const expired = createGatewayClient(
      "http://127.0.0.1:8787",
      vi.fn(async () => json({}, 401)) as unknown as typeof fetch,
    );
    await expect(expired.snapshot()).rejects.toThrow("App session expired");
  });

  it("prompts sign-in on an initial local demo 401, then reports an expired session after login", () => {
    const unauthorized = new GatewayRequestError(
      "App session expired. Sign in again.",
      401,
      "unauthorized",
    );
    expect(gatewaySnapshotErrorMessage(unauthorized, true, false)).toBeNull();
    expect(gatewaySnapshotErrorMessage(unauthorized, true, true)).toBe(
      "App session expired. Sign in again.",
    );
    expect(gatewaySnapshotErrorMessage(unauthorized, false, false)).toBe(
      "App session expired. Sign in again.",
    );
    expect(
      gatewaySnapshotErrorMessage(new Error("Gateway is offline"), true, false),
    ).toBe("Gateway is offline");
  });

  it("locks simulated approval without the explicit flag and exact loopback origin", async () => {
    expect(isLoopbackLocalDemo("http://127.0.0.1:3002", "1")).toBe(true);
    expect(isLoopbackLocalDemo("http://localhost:3002", "1")).toBe(false);
    expect(isLoopbackLocalDemo("https://127.0.0.1:3002", "1")).toBe(false);
    expect(isLoopbackLocalDemo("http://127.0.0.1:3002", undefined)).toBe(false);
    const fetcher = vi.fn(async () => json({}));
    const client = createGatewayClient(
      "http://127.0.0.1:3002",
      fetcher as typeof fetch,
    );
    await expect(client.demoLogin("A".repeat(24))).rejects.toThrow(
      "explicit loopback",
    );
    await expect(client.approveSimulated(approval(), "123456")).rejects.toThrow(
      "explicit loopback",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("submits exact card hash and connector number only after a simulated local login", async () => {
    const calls: { path: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ path: new URL(String(input)).pathname, init: init ?? {} });
        return json(
          calls.length === 1
            ? { simulated: true }
            : { approval: { status: "approved" } },
        );
      },
    ) as unknown as typeof fetch;
    const client = createGatewayClient("http://127.0.0.1:3002", fetcher, true);
    await client.demoLogin("A".repeat(24));
    await client.approveSimulated(approval("pairing"), "123456", "ABCD-EFGH");
    expect(calls.map((call) => call.path)).toEqual([
      "/demo/login",
      "/v1/app/pairing/ABCD-EFGH/approve",
    ]);
    expect(new Headers(calls[0]?.init.headers).get("Authorization")).toBe(
      `Bearer ${"A".repeat(24)}`,
    );
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      verification: {
        action_hash: approval("pairing").payload_hash,
        device_signature: "simulated-local-approval",
        request_number: "123456",
      },
    });
    expect(
      new Headers(calls[1]?.init.headers).get("Idempotency-Key"),
    ).toBeTruthy();
  });

  it("uses the decision route for payment and mandate, omitting numbers from everyday consent", async () => {
    const calls: { path: string; body: unknown }[] = [];
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          path: new URL(String(input)).pathname,
          body: JSON.parse(String(init?.body)),
        });
        return json({ approval: { status: "approved" } });
      },
    ) as unknown as typeof fetch;
    const client = createGatewayClient("http://127.0.0.1:3002", fetcher, true);
    await client.approveSimulated(approval("payment"), "654321");
    await client.approveSimulated({
      ...approval("mandate"),
      approval_id: "apr_mandate",
      subject_id: "mdt_local",
      level: "everyday",
    });
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/app/approvals/apr_local/decide",
      "/v1/app/approvals/apr_mandate/decide",
    ]);
    expect(calls[0]?.body).toMatchObject({
      decision: "approve",
      verification: {
        request_number: "654321",
        action_hash: approval().payload_hash,
      },
    });
    expect(calls[1]?.body).toEqual({
      decision: "approve",
      verification: {
        action_hash: approval("mandate").payload_hash,
        device_signature: "simulated-local-approval",
      },
    });
  });

  it("does not send expired, malformed, or mismatched pairing approvals", async () => {
    const fetcher = vi.fn(async () =>
      json({ approval: {} }),
    ) as unknown as typeof fetch;
    const client = createGatewayClient("http://127.0.0.1:3002", fetcher, true);
    await expect(
      client.approveSimulated(
        {
          ...approval(),
          expires_at: new Date(Date.now() - 1000).toISOString(),
        },
        "123456",
      ),
    ).rejects.toThrow("expired");
    await expect(client.approveSimulated(approval(), "12345")).rejects.toThrow(
      "six-digit",
    );
    await expect(
      client.approveSimulated(approval("pairing"), "123456", "WRONG-CODE"),
    ).rejects.toThrow("does not match");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports Gateway number rejection and network failure without claiming approval", async () => {
    const mismatch = createGatewayClient(
      "http://127.0.0.1:3002",
      vi.fn(async () =>
        json({ error: { code: "bad_signature" } }, 401),
      ) as unknown as typeof fetch,
      true,
    );
    await expect(
      mismatch.approveSimulated(approval(), "000000"),
    ).rejects.toMatchObject({
      status: 401,
      code: "bad_signature",
    } satisfies Partial<GatewayRequestError>);
    const offline = createGatewayClient(
      "http://127.0.0.1:3002",
      vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
      true,
    );
    await expect(
      offline.approveSimulated(approval(), "123456"),
    ).rejects.toThrow("Gateway is offline");
  });

  it("reads chain balances and funding history, then submits the exact reviewed owner transfer", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const challenge = {
      funding_id: "fnd_one",
      challenge_id: "fch_one",
      action_hash: `sha256:${"a".repeat(64)}`,
      expires_at: "2099-01-01T00:00:00Z",
      source_balance: { amount: 866000, currency: "CNY" },
      destination_balance: { amount: 0, currency: "CNY" },
      destination_address: `0x${"2".repeat(40)}`,
      simulated: true,
    };
    const record = {
      schema: "funding.v1",
      funding_id: "fnd_one",
      user_id: "usr_owner",
      amount: { amount: 100000, currency: "CNY" },
      source: "main",
      destination: "agent_wallet",
      status: "completed",
      chain: {
        network: "FISCO BCOS local",
        tx_hash: `0x${"3".repeat(64)}`,
        block_number: 2,
      },
      created_at: "2026-10-15T12:00:00Z",
      completed_at: "2026-10-15T12:00:01Z",
    };
    const fetcher = vi.fn(
      async (input: string | URL | Request, init: RequestInit = {}) => {
        const path = new URL(String(input)).pathname;
        calls.push({ path, init });
        if (path === "/v1/app/home")
          return json({
            schema: "home.v1",
            simulated: true,
            main_account: { balance: { amount: 866000, currency: "CNY" } },
            agent_wallet: {
              balance: { amount: 0, currency: "CNY" },
              reserved: { amount: 0, currency: "CNY" },
              available: { amount: 0, currency: "CNY" },
              address: challenge.destination_address,
              frozen: false,
            },
            block_number: 1,
            observed_at: "2026-10-15T12:00:00Z",
            alerts: [],
          });
        if (path === "/v1/app/agent-wallet/funding/prepare")
          return json(challenge);
        if (path === "/v1/app/agent-wallet/funding")
          return init.method === "POST"
            ? json(record)
            : json({ items: [record] });
        if (path === "/v1/app/agent-wallet/funding/fnd_one")
          return json(record);
        if (path === "/v1/app/agent-wallet/sweep" && init.method === "POST")
          return json({
            schema: "sweep.v1",
            sweep_id: "swp_one",
            status: "completed",
            amount: { amount: 50000, currency: "CNY" },
            chain: {
              network: "FISCO BCOS local",
              tx_hash: `0x${"4".repeat(64)}`,
            },
          });
        if (path === "/v1/app/agent-wallet/sweep")
          return json({
            items: [{ sweep_id: "swp_one", status: "completed" }],
          });
        if (path === "/v1/app/agent-wallet/sweep/swp_one")
          return json({ sweep_id: "swp_one", status: "completed" });
        throw new Error(`Unexpected ${path}`);
      },
    ) as unknown as typeof fetch;
    const client = createGatewayClient("http://127.0.0.1:3002", fetcher, true);
    expect((await client.home()).main_account.balance.amount).toBe(866000);
    expect((await client.fundingHistory())[0]?.chain.tx_hash).toBe(
      record.chain.tx_hash,
    );
    expect((await client.funding("fnd_one")).status).toBe("completed");
    const prepared = await client.prepareFunding(100000);
    expect(prepared.destination_address).toBe(challenge.destination_address);
    expect((await client.submitSimulatedFunding(prepared, 100000)).status).toBe(
      "completed",
    );
    expect((await client.sweep(50000)).status).toBe("completed");
    expect((await client.sweepHistory())[0]?.status).toBe("completed");
    expect((await client.sweepDetail("swp_one")).sweep_id).toBe("swp_one");
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/app/home",
      "/v1/app/agent-wallet/funding",
      "/v1/app/agent-wallet/funding/fnd_one",
      "/v1/app/agent-wallet/funding/prepare",
      "/v1/app/agent-wallet/funding",
      "/v1/app/agent-wallet/sweep",
      "/v1/app/agent-wallet/sweep",
      "/v1/app/agent-wallet/sweep/swp_one",
    ]);
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({
      amount: { amount: 100000, currency: "CNY" },
    });
    expect(JSON.parse(String(calls[4]?.init.body))).toEqual({
      funding_id: "fnd_one",
      challenge_id: "fch_one",
      amount: { amount: 100000, currency: "CNY" },
      verification: {
        action_hash: challenge.action_hash,
        device_signature: "simulated-local-funding",
      },
    });
    expect(new Headers(calls[4]?.init.headers).get("Idempotency-Key")).toBe(
      "funding-fnd_one",
    );
    expect(
      new Headers(calls[5]?.init.headers).get("Idempotency-Key"),
    ).toBeTruthy();
    expect(calls.every((call) => call.init.credentials === "include")).toBe(
      true,
    );
  });

  it("keeps funding writes locked outside explicit local mode", async () => {
    const fetcher = vi.fn(async () => json({}));
    const client = createGatewayClient(
      "https://bank.example",
      fetcher as unknown as typeof fetch,
      false,
    );
    await expect(client.prepareFunding(100)).rejects.toThrow(
      "explicit loopback",
    );
    expect(() =>
      client.submitSimulatedFunding({ funding_id: "fnd_one" } as never, 100),
    ).toThrow("explicit loopback");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed or fixture-like balance responses before showing money", async () => {
    const client = createGatewayClient(
      "http://127.0.0.1:3002",
      vi.fn(async () =>
        json({
          schema: "home.v1",
          simulated: true,
          main_account: { balance: { amount: 866000, currency: "CNY" } },
        }),
      ) as unknown as typeof fetch,
      true,
    );
    await expect(client.home()).rejects.toThrow("invalid chain balance");
  });

  it("rejects a chain observation timestamp far in the future", async () => {
    const client = createGatewayClient(
      "http://127.0.0.1:3002",
      vi.fn(async () =>
        json({
          schema: "home.v1",
          simulated: true,
          main_account: { balance: { amount: 866000, currency: "CNY" } },
          agent_wallet: {
            balance: { amount: 0, currency: "CNY" },
            reserved: { amount: 0, currency: "CNY" },
            available: { amount: 0, currency: "CNY" },
            address: `0x${"2".repeat(40)}`,
            frozen: false,
          },
          block_number: 1,
          observed_at: new Date(Date.now() + 60_000).toISOString(),
          alerts: [],
        }),
      ) as unknown as typeof fetch,
      true,
    );
    await expect(client.home()).rejects.toThrow("invalid chain balance");
  });

  it("surfaces an insufficient-main-funds rule from the Gateway funding response", async () => {
    const client = createGatewayClient(
      "http://127.0.0.1:3002",
      vi.fn(async () =>
        json(
          {
            error: {
              code: "policy_denied",
              rule: "insufficient_main_funds",
              detail: {},
              user_explanation:
                "The simulated main account does not have enough confirmed funds.",
              fixable: false,
            },
          },
          403,
        ),
      ) as unknown as typeof fetch,
      true,
    );
    await expect(
      client.submitSimulatedFunding(
        {
          funding_id: "fnd_one",
          challenge_id: "fch_one",
          action_hash: `sha256:${"a".repeat(64)}`,
          expires_at: "2099-01-01T00:00:00Z",
          source_balance: { amount: 866000, currency: "CNY" },
          destination_balance: { amount: 0, currency: "CNY" },
          destination_address: `0x${"2".repeat(40)}`,
          simulated: true,
        },
        800000,
      ),
    ).rejects.toMatchObject({
      code: "policy_denied",
      details: { rule: "insufficient_main_funds" },
      message:
        "The confirmed main-account balance is too low for this transfer.",
    });
  });

  it("passes decoded QR content to the app-only scan path and confirms only in explicit loopback demo mode", async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const review = {
      kind: "payment" as const,
      confirmation_id: "hpm_one",
      challenge_id: "hpc_one",
      action_hash: `sha256:${"a".repeat(64)}`,
      merchant_id: "mch_shopA",
      merchant_legal_name: "BaoTaoShop (mock)",
      merchant_uscc: "MOCK91440300TEST001",
      order_id: "ord_one",
      amount: { amount: 28400, currency: "CNY" as const },
      source_account: "main" as const,
      expires_at: "2099-01-01T00:00:00Z",
      simulated: true as const,
    };
    const receipt = {
      schema: "human_payment.v1",
      confirmation_id: "hpm_one",
      order_id: "ord_one",
      merchant_id: "mch_shopA",
      amount: review.amount,
      source_account: "main",
      status: "completed",
      chain: { network: "FISCO BCOS local", tx_hash: `0x${"b".repeat(64)}` },
      created_at: "2026-10-15T00:00:00Z",
    };
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        calls.push({ path, init: init ?? {} });
        if (path === "/v1/app/scan/decode") return json(review);
        return json(receipt);
      },
    ) as unknown as typeof fetch;
    const client = createGatewayClient("http://127.0.0.1:3002", fetcher, true);
    expect(await client.scanPayload("ecny://pay?d=signed")).toEqual(review);
    expect(await client.confirmSimulatedHumanPayment(review)).toEqual(receipt);
    expect(await client.humanPayment(review.confirmation_id)).toEqual(receipt);
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/app/scan/decode",
      "/v1/app/scan/payments/hpm_one/confirm",
      "/v1/app/scan/payments/hpm_one",
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      qr_payload: "ecny://pay?d=signed",
    });
    expect(new Headers(calls[1]?.init.headers).get("Idempotency-Key")).toBe(
      "human-payment-hpm_one",
    );
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      challenge_id: "hpc_one",
      verification: {
        action_hash: review.action_hash,
        device_signature: "simulated-local-human-payment",
      },
    });
    const nonDemo = createGatewayClient("https://bank.example", fetcher, false);
    expect(() => nonDemo.confirmSimulatedHumanPayment(review)).toThrow(
      "explicit loopback",
    );
    expect(calls).toHaveLength(3);
  });
});
