import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Decision, Mandate } from "@webank/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "../src/app.js";
import {
  BankConsoleTape,
  isLoopbackConsoleRequest,
} from "../src/bank-console.js";
import type { GatewayDependencies } from "../src/types.js";

const at = "2026-10-20T03:00:00.000Z";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("Bank Console projection", () => {
  it("shows only trusted demo lock facts, actual checks, and measured Guardian timing", () => {
    const tape = new BankConsoleTape();
    const mandate = {
      mandate_id: "mdt_abcdef123456",
      created_at: at,
      user_text: "Sensitive private request",
      constraints: [
        {
          type: "product",
          brand: "Nova",
          model: "Quiet 3",
          gtin: "6901234567001",
          skus: ["NOVA-Q3-BLK"],
        },
        { type: "budget", max: { amount: 30000, currency: "CNY" } },
      ],
    } as Mandate;
    tape.recordMandate(mandate);
    tape.recordPaymentDecision({
      paymentId: "pay_abcdef123456",
      mandate,
      merchantId: "mch_shopA",
      amountFen: 28400,
      light: "AMBER",
      guardianElapsedMs: 1834,
      guardianSource: "Hermes",
      decision: {
        created_at: at,
        outcome: "STEP_UP",
        user_explanation: "Sensitive model explanation",
        checks: [
          { name: "agent_auth", result: "pass" },
          { name: "rail_validation", result: "pass" },
          { name: "mandate", result: "pass" },
          { name: "policy_licence", result: "step_up" },
          { name: "risk", result: "skipped" },
          {
            name: "guardian",
            result: "pass",
            detail: { explanation: "Sensitive Guardian explanation" },
          },
        ],
      } as Decision,
    });
    const payload = JSON.stringify(tape.feed(0));
    expect(payload).toContain("Nova Quiet 3");
    expect(payload).toContain('"variant":"Black"');
    expect(payload).toContain('"max_fen":30000');
    expect(payload).toContain('"result":"skipped"');
    expect(payload).toContain('"elapsed_ms":1834');
    expect(
      tape
        .feed(0)
        .events.find(
          (event) =>
            event.kind === "mandate_lock" && event.subject?.startsWith("pay_"),
        ),
    ).toBeTruthy();
    expect(payload).not.toContain("Sensitive");
    expect(payload).not.toContain("6901234567001");
    expect(payload).not.toContain("pay_abcdef123456");
    expect(tape.feed(tape.feed(0).next_cursor).events).toEqual([]);
  });

  it("keeps proof flags and exact confirmed block without numbers, proofs, or full hashes", () => {
    const tape = new BankConsoleTape();
    tape.recordPairing({
      agentId: "agt_abcdef123456",
      clientAppName: "Private person's app",
      simulated: true,
      at,
    });
    tape.recordOwnerApproval({
      paymentId: "pay_abcdef123456",
      requestNumberMatched: true,
      simulated: true,
      at,
    });
    tape.recordSettlement({
      paymentId: "pay_abcdef123456",
      status: "paid",
      approvalSource: "owner",
      tx: `0x${"a".repeat(64)}`,
      blockNumber: 412n,
      at,
    });
    tape.recordSettlement({
      paymentId: "pay_abcdef123456",
      status: "paid",
      approvalSource: "owner",
      tx: `0x${"a".repeat(64)}`,
      blockNumber: 412n,
      at,
    });
    const feed = tape.feed(0);
    expect(feed.events).toHaveLength(3);
    expect(feed.events[0]).toMatchObject({
      app: "Connected app",
      request_number_matched: true,
      biometric: "simulated",
    });
    expect(feed.events[2]).toMatchObject({
      status: "paid",
      tx_preview: "0xaaaaaa…",
      block_number: "412",
    });
    expect(JSON.stringify(feed)).not.toContain(`0x${"a".repeat(64)}`);
    expect(JSON.stringify(feed)).not.toContain("Private person's app");
  });

  it("reads only private, fixed-schema Treasurer simulations", () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-console-"));
    directories.push(directory);
    const path = join(directory, "simulation.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          schema: "console_simulation.v1",
          scene: "treasurer_topup_blocked",
          at,
          amount_fen: 200000,
        }),
        JSON.stringify({
          schema: "console_simulation.v1",
          scene: "treasurer_renewal_paid",
          at,
          amount_fen: 5000,
          token: "secret",
        }),
        JSON.stringify({
          schema: "console_simulation.v1",
          scene: "unknown",
          at,
          amount_fen: 5000,
        }),
        "{not complete",
      ].join("\n"),
      { mode: 0o600 },
    );
    const tape = new BankConsoleTape(path);
    expect(tape.feed(0).events).toMatchObject([
      {
        kind: "simulation",
        scene: "treasurer_topup_blocked",
        amount_fen: 200000,
        simulated: true,
      },
    ]);
    expect(tape.feed(0).events).toHaveLength(1);
    chmodSync(path, 0o644);
    expect(new BankConsoleTape(path).feed(0).events).toEqual([]);
  });

  it("keeps distinct short subjects when internal IDs share a long prefix", () => {
    const tape = new BankConsoleTape();
    tape.recordEarlyDenial({
      decisionId: "dec_abcdef1234560000000001",
      code: "merchant_unknown",
      at,
    });
    tape.recordEarlyDenial({
      decisionId: "dec_abcdef1234560000000002",
      code: "merchant_unknown",
      at,
    });
    const subjects = tape
      .feed(0)
      .events.filter((event) => event.kind === "payment")
      .map((event) => event.subject);
    expect(new Set(subjects).size).toBe(2);
    expect(
      tape.feed(0).events.filter((event) => event.kind === "check"),
    ).toEqual([]);
    expect(
      tape.feed(0).events.filter((event) => event.kind === "precheck_denial"),
    ).toHaveLength(2);
    expect(
      subjects.every((subject) => /^dec_[0-9a-f]{10}…$/.test(subject ?? "")),
    ).toBe(true);
  });

  it("does not present inconsistent agent-supplied product fields as a trusted lock", () => {
    const tape = new BankConsoleTape();
    tape.recordMandate({
      mandate_id: "mdt_untrusted",
      created_at: at,
      constraints: [
        {
          type: "product",
          brand: "Different brand",
          model: "Quiet 3",
          gtin: "6901234567001",
          skus: ["NOVA-Q3-BLK"],
        },
      ],
    } as Mandate);
    expect(tape.feed(0).events[0]).toMatchObject({
      model: "Product unavailable",
      gtin_preview: "Unavailable",
    });
    expect(JSON.stringify(tape.feed(0))).not.toContain("Different brand");
  });
});

describe("loopback-only Console routes", () => {
  it("enforces peer, Host, and same-origin checks", () => {
    expect(
      isLoopbackConsoleRequest("127.0.0.1", "127.0.0.1:3002", undefined),
    ).toBe(true);
    expect(
      isLoopbackConsoleRequest("192.0.2.3", "127.0.0.1:3002", undefined),
    ).toBe(false);
    expect(isLoopbackConsoleRequest("127.0.0.1", "evil.test", undefined)).toBe(
      false,
    );
    expect(
      isLoopbackConsoleRequest(
        "127.0.0.1",
        "127.0.0.1:3002",
        "http://evil.test",
      ),
    ).toBe(false);
  });

  it("serves only read-only sanitized GETs without browser credentials", async () => {
    const app = createGateway(
      { bankConsoleEnabled: true } as GatewayDependencies,
      { agents: [], policies: [] },
    );
    try {
      const page = await app.inject({
        method: "GET",
        url: "/demo/console",
        headers: { host: "127.0.0.1:3002" },
      });
      expect(page.statusCode).toBe(200);
      expect(page.headers["content-type"]).toContain("text/html");
      expect(page.headers["content-security-policy"]).toContain(
        "connect-src 'self'",
      );
      expect(page.body).toContain("LOCAL DEMO · READ ONLY");
      expect(page.body).toContain('credentials: "omit"');
      expect(page.body).toContain('aria-live="polite"');
      expect(page.body).toContain("@media (max-width: 480px)");
      expect(page.body).not.toContain("Bearer ");
      const inlineScript = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      expect(inlineScript).toBeDefined();
      expect(() => new Function(inlineScript)).not.toThrow();
      const feed = await app.inject({
        method: "GET",
        url: "/v1/demo/console/events?after=0",
        headers: { host: "127.0.0.1:3002" },
      });
      expect(feed.json()).toEqual({
        schema: "bank_console_feed.v1",
        events: [],
        next_cursor: 0,
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/demo/console/events",
            headers: { host: "127.0.0.1:3002" },
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/demo/console/events?after=-1",
            headers: { host: "127.0.0.1:3002" },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/demo/console/events",
            headers: { host: "evil.test" },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("answers a real ephemeral loopback HTTP request without an app token", async () => {
    const app = createGateway(
      { bankConsoleEnabled: true } as GatewayDependencies,
      { agents: [], policies: [] },
    );
    try {
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const page = await fetch(`${origin}/demo/console`);
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(await page.text()).toContain("Bank Console");
      const events = await fetch(`${origin}/v1/demo/console/events?after=0`);
      expect(events.status).toBe(200);
      expect(await events.json()).toEqual({
        schema: "bank_console_feed.v1",
        events: [],
        next_cursor: 0,
      });
    } finally {
      await app.close();
    }
  });
});
