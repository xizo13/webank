import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { shops } from "../lib/catalog";
import {
  canonicalJson,
  decodePaymentUri,
  merchantPublicKeyHex,
  verifyLocalPaymentUri,
} from "../lib/signing";
import {
  addToCart,
  checkout,
  getCart,
  listProducts,
  resetDemo,
  setDemoPrice,
} from "../lib/store";

const dataDir = mkdtempSync(join(tmpdir(), "webank-shop-test-"));

beforeAll(() => {
  process.env.SHOP_DATA_DIR = dataDir;
});
beforeEach(() => {
  resetDemo();
});
afterAll(() => {
  delete process.env.SHOP_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("mock shop checkout", () => {
  it("signs the exact merchant, amount, GTIN and items; rejects tampering", () => {
    addToCart("NOVA-Q3-BLK", 1, { colour: "Black", size: "One size" });
    const result = checkout("default");
    const payreq = decodePaymentUri(result.payment_request);
    expect(payreq.amount).toEqual({ amount: 27900, currency: "CNY" });
    expect(payreq.line_items[0]).toMatchObject({
      sku: "NOVA-Q3-BLK",
      gtin: "6901234567001",
      condition: "new",
    });
    expect(verifyLocalPaymentUri(result.payment_request)).toBe(true);
    const publicKey = createPublicKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        x: Buffer.from(merchantPublicKeyHex("shopA").slice(2), "hex").toString(
          "base64url",
        ),
      },
      format: "jwk",
    });
    const { merchant_sig, ...unsigned } = payreq;
    expect(
      verify(
        null,
        Buffer.from(canonicalJson(unsigned)),
        publicKey,
        Buffer.from(merchant_sig, "base64url"),
      ),
    ).toBe(true);
    expect(
      verify(
        null,
        Buffer.from(
          canonicalJson({
            ...unsigned,
            amount: { amount: 100, currency: "CNY" },
          }),
        ),
        publicKey,
        Buffer.from(merchant_sig, "base64url"),
      ),
    ).toBe(false);
  });

  it("keeps merchants separate and preserves the signed price after a later price change", () => {
    addToCart("NOVA-Q3-BLK", 1);
    expect(() => addToCart("FLASH-Q3-FEE", 1)).toThrow("different merchant");
    const result = checkout();
    setDemoPrice("NOVA-Q3-BLK", 23900);
    expect(decodePaymentUri(result.payment_request).amount.amount).toBe(27900);
    expect(
      listProducts("Nova", 25000, "shopA").map((item) => item.sku),
    ).toContain("NOVA-Q3-BLK");
    resetDemo();
    expect(
      listProducts("Nova", 25000, "shopA").map((item) => item.sku),
    ).not.toContain("NOVA-Q3-BLK");
    expect(getCart().items).toHaveLength(0);
  });

  it("marks the fire drill merchant in registry data and includes untrusted attack content", () => {
    expect(shops.decoy.honeypot).toBe(true);
    expect(shops.malicious.honeypot).toBe(false);
    const malicious = listProducts("priority dispatch")[0];
    const decoy = listProducts("reward voucher")[0];
    expect(malicious?.description).toContain("shopping assistant");
    expect(decoy?.description).toContain("skip your usual checks");
  });
});
