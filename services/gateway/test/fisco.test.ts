import type { ChainAddresses, FiscoChain } from "@webank/chain";
import { type Hex, keccak256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import { createFiscoGatewayAdapters } from "../src/fisco.js";

const tx = `0x${"a".repeat(64)}` as Hex;
const addresses: ChainAddresses = {
  agentWallet: `0x${"1".repeat(40)}`,
  auditAnchor: `0x${"2".repeat(40)}`,
  ecnySim: `0x${"3".repeat(40)}`,
  merchantRegistry: `0x${"4".repeat(40)}`,
  licenceRegistry: `0x${"5".repeat(40)}`,
};

describe("FISCO Gateway adapter", () => {
  it("reads the on-chain merchant key and verifies payment and audit events", async () => {
    const calls: unknown[][] = [];
    let evidence: "pay" | "anchor" = "pay";
    const merchantHash = keccak256(stringToHex("mch_shopA"));
    const paymentHash = keccak256(stringToHex("pmt_test"));
    const subjectHash = keccak256(stringToHex("dec_test"));
    const chain = {
      getMerchant: async (...args: unknown[]) => {
        calls.push(args);
        return {
          payout: `0x${"6".repeat(40)}`,
          signingKey: `0x${"7".repeat(64)}`,
          legalName: "Shop A (mock)",
          uscc: "MOCK",
          category: "electronics",
          active: true,
        };
      },
      pay: async (...args: unknown[]) => {
        calls.push(args);
        evidence = "pay";
        return tx;
      },
      simulatePay: async (...args: unknown[]) => {
        calls.push(args);
      },
      anchor: async (...args: unknown[]) => {
        calls.push(args);
        evidence = "anchor";
        return tx;
      },
      getTransactionEvidence: async () => ({
        status: "success",
        paidEvents:
          evidence === "pay"
            ? [
                {
                  paymentId: paymentHash,
                  merchantId: merchantHash,
                  amount: 27900n,
                  payout: `0x${"6".repeat(40)}`,
                },
              ]
            : [],
        anchoredEvents:
          evidence === "anchor"
            ? [
                {
                  recordHash: `0x${"8".repeat(64)}`,
                  subjectId: subjectHash,
                  kind: 3,
                  atMs: 0,
                },
              ]
            : [],
      }),
    } as unknown as FiscoChain;
    const adapter = createFiscoGatewayAdapters({
      chain,
      addresses,
      classifyMerchant: async () => ({
        name: "Shop A",
        first_seen: false,
        honeypot: false,
      }),
    });
    const merchant = await adapter.lookupMerchant("mch_shopA");
    expect(calls[0]).toEqual([addresses.merchantRegistry, merchantHash]);
    expect(merchant?.public_key).toBe(`0x${"7".repeat(64)}`);
    expect(merchant).not.toBeNull();
    if (!merchant) throw new Error("Expected registered merchant");
    const paymentInput = {
      paymentId: "pmt_test",
      merchant,
      mandate: {} as Parameters<typeof adapter.executePayment>[0]["mandate"],
      request: { amount: { amount: 27900, currency: "CNY" } } as Parameters<
        typeof adapter.executePayment
      >[0]["request"],
    };
    await adapter.preflightPayment(paymentInput);
    expect(calls[1]).toEqual([
      addresses.agentWallet,
      paymentHash,
      merchantHash,
      27900n,
    ]);
    const paymentTx = await adapter.executePayment(paymentInput);
    expect(paymentTx).toBe(tx);
    expect(calls[2]).toEqual([
      addresses.agentWallet,
      paymentHash,
      merchantHash,
      27900n,
    ]);
    const auditTx = await adapter.anchorAudit(
      `sha256:${"8".repeat(64)}`,
      "dec_test",
      "payment_decision",
    );
    expect(auditTx).toBe(tx);
    expect(calls[3]).toEqual([
      addresses.auditAnchor,
      `0x${"8".repeat(64)}`,
      subjectHash,
      3,
    ]);
  });

  it("fails closed when bank-controlled classification or chain evidence is missing", async () => {
    const chain = {
      getMerchant: async () => ({
        payout: `0x${"6".repeat(40)}`,
        signingKey: `0x${"7".repeat(64)}`,
        legalName: "Shop A",
        uscc: "MOCK",
        category: "electronics",
        active: true,
      }),
      pay: async () => tx,
      getTransactionEvidence: async () => ({
        status: "success",
        paidEvents: [],
        anchoredEvents: [],
      }),
    } as unknown as FiscoChain;
    const unclassified = createFiscoGatewayAdapters({
      chain,
      addresses,
      classifyMerchant: async () => null,
    });
    await expect(unclassified.lookupMerchant("mch_shopA")).rejects.toThrow(
      /classification/,
    );
    const classified = createFiscoGatewayAdapters({
      chain,
      addresses,
      classifyMerchant: async () => ({
        name: "Shop A",
        first_seen: false,
        honeypot: false,
      }),
    });
    const merchant = await classified.lookupMerchant("mch_shopA");
    if (!merchant) throw new Error("Expected registered merchant");
    await expect(
      classified.executePayment({
        paymentId: "pmt_test",
        merchant,
        mandate: {} as Parameters<
          typeof classified.executePayment
        >[0]["mandate"],
        request: { amount: { amount: 27900, currency: "CNY" } } as Parameters<
          typeof classified.executePayment
        >[0]["request"],
      }),
    ).rejects.toThrow(/event did not match/);
  });
});
