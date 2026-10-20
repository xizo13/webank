import { describe, expect, it } from "vitest";
import { denialFromChecks } from "../src/denials.js";

describe("denial rule mapping", () => {
  it("does not disguise internal currency or policy faults as user cap denials", () => {
    expect(() =>
      denialFromChecks([
        {
          name: "mandate",
          result: "deny",
          detail: { reason: "currency_mismatch" },
        },
      ]),
    ).toThrow();
    expect(() =>
      denialFromChecks([
        {
          name: "policy_licence",
          result: "deny",
          detail: { reason: "policy_missing" },
        },
      ]),
    ).toThrow();
  });

  it("does not invent intent mismatch when no check denied", () => {
    expect(() =>
      denialFromChecks([{ name: "policy_licence", result: "step_up" }]),
    ).toThrow();
  });

  it("keeps an uncorroborated Guardian other denial neutral", () => {
    expect(
      denialFromChecks([
        { name: "guardian", result: "deny", detail: { reason: "other" } },
      ]),
    ).toMatchObject({
      code: "guardian_denied",
      rule: "guardian_other",
      user_explanation:
        "WeBank's Guardian could not safely approve this purchase.",
    });
    expect(
      denialFromChecks([
        {
          name: "guardian",
          result: "deny",
          detail: { reason: "intent_mismatch" },
        },
      ]),
    ).toMatchObject({ code: "guardian_denied", rule: "intent_mismatch" });
  });
});
