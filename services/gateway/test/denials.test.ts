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
});
