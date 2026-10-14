import { describe, expect, it } from "vitest";
import { presentApproval } from "./approvalPresentation";
import type { Approval } from "./flow";
import type { LivePayment } from "./gateway";

const base: Approval = {
  approval_id: "apr_example",
  kind: "payment",
  subject_id: "pay_example",
  title: "Demo assistant wants to pay 279 CNY",
  lines: [
    "To: Gateway Mock Shop Ltd. (simulation)",
    "For: 1 x Mock headphones",
    "Why asking: policy_licence, guardian",
  ],
  payload_hash: `sha256:${"a".repeat(64)}`,
  level: "zero_trust",
  expires_at: "2026-10-14T12:03:00Z",
  status: "pending",
};

describe("approval presentation", () => {
  it("uses structured payment amount and explains review reasons without raw codes", () => {
    const payment: LivePayment = {
      payment_id: "pay_example",
      status: "awaiting_user",
      amount: { amount: 27_900, currency: "CNY" },
      merchant: "Gateway Mock Shop",
      created_at: "2026-10-14T12:00:00Z",
    };
    const view = presentApproval(base, payment);
    expect(view.title).toBe("Demo assistant wants to pay ¥279.00");
    expect(view.lines[2]).toContain("Wallet policy or the agent licence");
    expect(view.lines[2]).toContain("purchase safety check");
    expect(view.lines.join(" ")).not.toMatch(/policy_licence|guardian/);
  });

  it("shortens a long P-256 public key and preserves the ten-minute pairing deadline", () => {
    const key = `p256:${"A".repeat(90)}`;
    const consent: Approval = {
      ...base,
      kind: "pairing",
      subject_id: "ABCD-EFGH",
      title: "Connect an agent to WeBank",
      lines: [`Public key: ${key}`],
      expires_at: "2026-10-14T12:10:00Z",
    };
    const view = presentApproval(consent);
    expect(view.lines[0]).toBe(
      `Public key preview: ${key.slice(0, 16)}…${key.slice(-10)}`,
    );
    expect(view.lines[0]?.length).toBeLessThan(55);
    expect(consent.expires_at).toBe("2026-10-14T12:10:00Z");
    expect(consent.lines[0]).toContain(key);
  });

  it("uses a safe generic explanation for unknown review codes", () => {
    const view = presentApproval({
      ...base,
      lines: ["Why asking: new_internal_code"],
    });
    expect(view.lines).toEqual([
      "This request needs your review before it can continue.",
    ]);
  });
});
