import { describe, expect, it } from "vitest";
import { createLocalBankExecutor } from "../src/bank-executor.js";
import { isActiveFundedDeployment } from "../src/funded-deployment.js";

const legacy = {
  agentWallet: `0x${"1".repeat(40)}`,
  auditAnchor: `0x${"2".repeat(40)}`,
  ecnySim: `0x${"3".repeat(40)}`,
  merchantRegistry: `0x${"4".repeat(40)}`,
  licenceRegistry: `0x${"5".repeat(40)}`,
} as const;
const bank = `0x${"9".repeat(40)}` as const;
const native = {
  ...legacy,
  bank,
  chainId: 20200,
  rpcUrl: "http://127.0.0.1:8545",
  deploymentFingerprint: "f".repeat(64),
  txHashes: Object.fromEntries(
    [
      "deployECnySim",
      "deployMerchantRegistry",
      "deployLicenceRegistry",
      "deployAuditAnchor",
      "deployAgentWallet",
      "openingMint",
      "configureAgentWallet",
    ].map((name, index) => [
      name,
      `0x${(index + 1).toString(16).padStart(64, "0")}`,
    ]),
  ),
};

describe("active local funded deployment classification", () => {
  it("accepts the verified native manifest for the real bank executor", () => {
    expect(isActiveFundedDeployment(native)).toBe(true);
    const executor = createLocalBankExecutor(
      "/tmp/disposable-state.json",
      native,
    );
    expect(typeof executor.fund).toBe("function");
    expect(typeof executor.setCaps).toBe("function");
  });

  it("retains active migration and bare legacy fixture behavior", () => {
    expect(
      isActiveFundedDeployment({
        ...legacy,
        bank,
        migration: { state: "active" },
      }),
    ).toBe(true);
    expect(isActiveFundedDeployment(legacy)).toBe(false);
    expect(() =>
      createLocalBankExecutor("/tmp/disposable-state.json", legacy),
    ).toThrow("active funding deployment");
  });

  it("rejects partial native evidence and staged migration before a bank write", () => {
    expect(() =>
      isActiveFundedDeployment({ ...native, txHashes: undefined }),
    ).toThrow("incomplete");
    expect(() =>
      isActiveFundedDeployment({
        ...native,
        txHashes: {
          ...native.txHashes,
          openingMint: native.txHashes.deployECnySim,
        },
      }),
    ).toThrow("incomplete");
    expect(() =>
      isActiveFundedDeployment({
        ...legacy,
        bank,
        migration: { state: "staged" },
      }),
    ).toThrow("not active");
    expect(() =>
      createLocalBankExecutor("/tmp/disposable-state.json", {
        ...native,
        deploymentFingerprint: "bad",
      }),
    ).toThrow("incomplete");
  });
});
