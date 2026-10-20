import { describe, expect, it } from "vitest";
import { trustOrdinal } from "../src/trust-light.js";

describe("bank LicenceRegistry level mapping", () => {
  it("writes Amber for pairing and owner return, Green for promotion, and Red for hard restriction", () => {
    expect(trustOrdinal("AMBER")).toBe(1);
    expect(trustOrdinal("GREEN")).toBe(2);
    expect(trustOrdinal("RED")).toBe(4);
  });
  it("never writes the historical ordinal 3 or an unknown light", () => {
    expect(() => trustOrdinal(3)).toThrow("Invalid trust light");
    expect(() => trustOrdinal("FULL")).toThrow("Invalid trust light");
  });
});
