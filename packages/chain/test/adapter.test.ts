import { encodeErrorResult, parseAbi } from "viem";
import { describe, expect, it } from "vitest";
import { AgentWalletAbi } from "../src/generated/abis.js";
import { decodeChainRevert, normalizeBlockTimestamp } from "../src/index.js";

describe("FISCO adapter", () => {
  it("decodes a FISCO code-16 revert with empty message", () => {
    const data = encodeErrorResult({
      abi: parseAbi(["error Error(string)"]),
      errorName: "Error",
      args: ["over payment cap"],
    });
    const rpcError = { code: 16, message: "", data };
    expect(decodeChainRevert({ cause: rpcError }, AgentWalletAbi)).toBe(
      "over payment cap",
    );
  });

  it("normalizes both FISCO milliseconds and EVM seconds", () => {
    expect(normalizeBlockTimestamp(1_791_945_431_182n)).toBe(1_791_945_431_182);
    expect(normalizeBlockTimestamp(1_791_945_431n)).toBe(1_791_945_431_000);
  });
});
