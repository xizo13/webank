import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { shops } from "../lib/catalog";
import {
  canonicalJson,
  decodePaymentUri,
  encodePaymentUri,
  merchantPublicKeyHex,
  verifyLocalPaymentUri,
} from "../lib/signing";
import {
  addToCart,
  checkout,
  getCart,
  getOrder,
  listProducts,
  removeFromCart,
  resetDemo,
  setDemoPrice,
  setDemoScenario,
} from "../lib/store";

const dataDir = mkdtempSync(join(tmpdir(), "webank-shop-test-"));
const shippingAddress = {
  name: "Lin Demo",
  phone: "13800138000",
  address_line: "88 Demo Road",
  city: "Shenzhen",
  postcode: "518000",
};

beforeAll(() => {
  process.env.SHOP_DATA_DIR = dataDir;
});
beforeEach(() => {
  resetDemo({ clearDrill: true });
});
afterAll(() => {
  delete process.env.SHOP_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("mock shop checkout", () => {
  it("removes one exact variant without changing the other cart line", () => {
    addToCart("NOVA-Q3-BLK", 1, { colour: "Black", size: "One size" });
    addToCart("NOVA-Q3-STN", 2, { colour: "Stone", size: "One size" });
    const cart = removeFromCart("NOVA-Q3-BLK");
    expect(cart.items.map((item) => [item.sku, item.qty])).toEqual([
      ["NOVA-Q3-STN", 2],
    ]);
    expect(cart.total.amount).toBe(55_800);
    expect(() => removeFromCart("NOVA-Q3-BLK")).toThrow("Item not in cart");
    expect(getCart().items.map((item) => item.sku)).toEqual(["NOVA-Q3-STN"]);
  });

  it("rejects a colour under the wrong SKU and requires a shipping address before signing", () => {
    expect(() =>
      addToCart("NOVA-Q3-BLK", 1, { colour: "Stone", size: "One size" }),
    ).toThrow("Variant does not match SKU");
    addToCart("NOVA-Q3-BLK", 1, { colour: "Black", size: "One size" });
    expect(() => checkout()).toThrow("Shipping address is required");
  });

  it("signs the exact merchant, amount, GTIN and items; rejects tampering", () => {
    addToCart("NOVA-Q3-BLK", 1, { colour: "Black", size: "One size" });
    const result = checkout(shippingAddress);
    const payreq = decodePaymentUri(result.payment_request);
    expect(payreq.amount).toEqual({ amount: 28400, currency: "CNY" });
    expect(payreq.line_items[0]).toMatchObject({
      type: "product",
      sku: "NOVA-Q3-BLK",
      gtin: "6901234567001",
      condition: "new",
      variant: "Black",
      options: { colour: "Black", size: "One size" },
    });
    expect(payreq.line_items[1]).toEqual({
      type: "shipping",
      name: "Standard delivery",
      qty: 1,
      unit_price: { amount: 500, currency: "CNY" },
    });
    expect(getOrder(result.order_id)?.shipping_address).toEqual(
      shippingAddress,
    );
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
    const switchedColour = encodePaymentUri({
      ...payreq,
      line_items: payreq.line_items.map((item) =>
        item.type === "product"
          ? { ...item, options: { colour: "Stone", size: "One size" } }
          : item,
      ),
    });
    expect(verifyLocalPaymentUri(switchedColour)).toBe(false);
  });

  it("keeps two selected colours on separate signed lines and in the order", () => {
    addToCart("NOVA-Q3-BLK", 1, { colour: "Black", size: "One size" });
    addToCart("NOVA-Q3-STN", 1, { colour: "Stone", size: "One size" });
    const result = checkout(shippingAddress);
    const request = decodePaymentUri(result.payment_request);
    expect(
      request.line_items
        .filter((item) => item.type === "product")
        .map((item) => item.options),
    ).toEqual([
      { colour: "Black", size: "One size" },
      { colour: "Stone", size: "One size" },
    ]);
    expect(request.line_items[1]).toMatchObject({
      sku: "NOVA-Q3-STN",
      gtin: "6901234567003",
      variant: "Stone",
    });
    expect(
      getOrder(result.order_id)?.items.map((item) => item.options),
    ).toEqual([
      { colour: "Black", size: "One size" },
      { colour: "Stone", size: "One size" },
    ]);
    expect(verifyLocalPaymentUri(result.payment_request)).toBe(true);
  });

  it("keeps merchants separate and preserves the signed price after a later price change", () => {
    addToCart("NOVA-Q3-BLK", 1, { colour: "Black", size: "One size" });
    setDemoScenario("attack", true);
    expect(() => addToCart("FLASH-Q3-FEE", 1)).toThrow("different merchant");
    const result = checkout(shippingAddress);
    setDemoPrice("NOVA-Q3-BLK", 23900);
    expect(decodePaymentUri(result.payment_request).amount.amount).toBe(28400);
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
    expect(listProducts("priority dispatch")).toHaveLength(0);
    expect(listProducts("reward voucher")).toHaveLength(0);
    setDemoScenario("attack", true);
    const malicious = listProducts("priority dispatch")[0];
    expect(malicious?.description).toContain("shopping assistant");
    expect(listProducts("reward voucher")).toHaveLength(0);
    setDemoScenario("drill", true);
    const decoy = listProducts("reward voucher")[0];
    expect(decoy?.description).toContain("skip your usual checks");
  });

  it("ranks the requested model first and gates attack and drill listings", () => {
    expect(
      listProducts("Nova Quiet 2").map(({ sku, match }) => [sku, match]),
    ).toEqual([
      ["NOVA-Q2-BLK", "exact"],
      ["NOVA-Q3-BLK", "related"],
    ]);
    expect(listProducts("reward voucher")).toHaveLength(0);
    expect(() => addToCart("REWARD-GIFT-500", 1)).toThrow("Product not found");
    setDemoScenario("drill", true);
    expect(listProducts("reward voucher")[0]).toMatchObject({
      sku: "REWARD-GIFT-500",
      match: "exact",
    });
    setDemoScenario("drill", false);
    expect(listProducts("reward voucher")).toHaveLength(0);
    setDemoScenario("attack", true);
    expect(listProducts("priority dispatch")[0]?.sku).toBe("FLASH-Q3-FEE");
    expect(listProducts("reward voucher")).toHaveLength(0);
    setDemoScenario("attack", false);
    expect(listProducts("priority dispatch")).toHaveLength(0);
    expect(listProducts("reward voucher")).toHaveLength(0);
  });
});
