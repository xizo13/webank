import { describe, expect, it } from "vitest";
import { parseYuanToFen } from "./funding";

describe("funding amount entry", () => {
  it("converts only positive exact integer fen", () => {
    expect(parseYuanToFen("1000")).toBe(100000);
    expect(parseYuanToFen("1.05")).toBe(105);
    expect(parseYuanToFen("0.01")).toBe(1);
    for (const value of [
      "0",
      "0.00",
      "1.005",
      "1e3",
      "-1",
      "1,000",
      "90071992547410",
    ])
      expect(parseYuanToFen(value)).toBeNull();
  });
});
