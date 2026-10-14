import { describe, expect, it, vi } from "vitest";
import type { Approval } from "./flow";
import {
  createGatewayClient,
  type GatewayRequestError,
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
    const consent = await client.pairing("ABCD-EFGH");
    expect(consent.approval.title).toBe("Connect");
    expect(JSON.stringify(consent)).not.toContain("request_number");
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/v1/app/pairing/ABCD-EFGH"),
      expect.objectContaining({ credentials: "include" }),
    );
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
});
