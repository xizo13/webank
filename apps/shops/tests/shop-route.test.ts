import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "../app/api/shop/route";
import { POST as setDrillVisibility } from "../app/internal/drill-visibility/route";
import { decodePaymentUri, verifyLocalPaymentUri } from "../lib/signing";
import { resetDemo } from "../lib/store";

const dataDir = mkdtempSync(join(tmpdir(), "webank-shop-route-test-"));
const base = "http://127.0.0.1:3001/api/shop";
const shipping_address = {
  name: "Lin Demo",
  phone: "13800138000",
  address_line: "88 Demo Road",
  city: "Shenzhen",
  postcode: "518000",
};

beforeAll(() => {
  process.env.SHOP_DATA_DIR = dataDir;
  process.env.SHOP_INTERNAL_TOKEN = "isolated-test-shop-token";
});
beforeEach(() => resetDemo({ clearDrill: true }));
afterAll(() => {
  delete process.env.SHOP_DATA_DIR;
  delete process.env.SHOP_INTERNAL_TOKEN;
  rmSync(dataDir, { recursive: true, force: true });
});

async function post(operation: string, body: Record<string, unknown> = {}) {
  const response = await POST(
    new NextRequest(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation, ...body }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

async function get(operation: string, params: Record<string, string> = {}) {
  const url = new URL(base);
  url.searchParams.set("operation", operation);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  const response = await GET(new NextRequest(url));
  return { status: response.status, body: await response.json() };
}

describe("shop HTTP checkout path used by MCP", () => {
  it("only the authenticated Gateway can change drill visibility", async () => {
    const endpoint = "http://127.0.0.1:3001/internal/drill-visibility";
    const missing = await setDrillVisibility(
      new NextRequest(endpoint, {
        method: "POST",
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(missing.status).toBe(401);
    expect((await get("scenarios")).body.scenarios).toEqual({ attack: false });
    const invalid = await setDrillVisibility(
      new NextRequest(endpoint, {
        method: "POST",
        headers: { authorization: "Bearer isolated-test-shop-token" },
        body: JSON.stringify({ enabled: "true" }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect((await get("scenarios")).body.scenarios).toEqual({ attack: false });
  });

  it("public attack mode reveals the malicious listing but not the registered decoy", async () => {
    const attack = await post("set_scenario", {
      scenario: "attack",
      enabled: true,
    });
    expect(attack.status).toBe(200);
    expect(
      (await get("search_products", { query: "priority dispatch" })).body[0]
        .sku,
    ).toBe("FLASH-Q3-FEE");
    expect(
      (await get("search_products", { query: "reward voucher" })).body,
    ).toEqual([]);
    expect((await get("get_product", { sku: "REWARD-GIFT-500" })).status).toBe(
      404,
    );
    expect((await get("scenarios")).body.scenarios).toEqual({ attack: true });
  });

  it("does not publish bank drill status in public shop scenario responses", async () => {
    const initial = await get("scenarios");
    expect(initial.body.scenarios).toEqual({ attack: false });
    const attack = await post("set_scenario", {
      scenario: "attack",
      enabled: true,
    });
    expect(attack.body.scenarios).toEqual({ attack: true });
    const drill = await setDrillVisibility(
      new NextRequest("http://127.0.0.1:3001/internal/drill-visibility", {
        method: "POST",
        headers: { authorization: "Bearer isolated-test-shop-token" },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(drill.status).toBe(200);
    expect((await get("scenarios")).body.scenarios).toEqual({ attack: true });
    const publicAttack = await post("set_scenario", {
      scenario: "attack",
      enabled: false,
    });
    expect(publicAttack.body.scenarios).toEqual({ attack: false });
  });

  it("removes a chosen SKU and returns the updated cart", async () => {
    await post("add_to_cart", {
      sku: "NOVA-Q3-BLK",
      qty: 1,
      options: { colour: "Black", size: "One size" },
    });
    await post("add_to_cart", {
      sku: "NOVA-Q3-STN",
      qty: 2,
      options: { colour: "Stone", size: "One size" },
    });
    const removed = await post("remove_from_cart", { sku: "NOVA-Q3-BLK" });
    expect(removed.status).toBe(200);
    expect(
      removed.body.cart.items.map((item: { sku: string }) => item.sku),
    ).toEqual(["NOVA-Q3-STN"]);
    expect(removed.body.cart.total.display).toBe("¥558.00");
    const missing = await post("remove_from_cart", { sku: "NOVA-Q3-BLK" });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toBe("Item not in cart");
  });

  it("locks the selected SKU, requires an address, and returns a signed item-plus-shipping order", async () => {
    const initial = await get("search_products", { query: "Nova Quiet 2" });
    expect(
      initial.body.map((item: { sku: string; match: string }) => [
        item.sku,
        item.match,
      ]),
    ).toEqual([
      ["NOVA-Q2-BLK", "exact"],
      ["NOVA-Q3-BLK", "related"],
    ]);
    expect(initial.body[0].price).toEqual({
      amount: 21_900,
      currency: "CNY",
      display: "¥219.00",
    });
    expect(initial.body[0]).toMatchObject({
      shop: "shopA",
      shop_name: "BaoTao Shop",
    });
    const detail = await get("get_product", { sku: "NOVA-Q2-BLK" });
    expect(detail.body).toMatchObject({
      shop: "shopA",
      shop_name: "BaoTao Shop",
    });
    expect(
      (await get("search_products", { query: "reward voucher" })).body,
    ).toEqual([]);
    const deniedDrill = await post("set_scenario", {
      scenario: "drill",
      enabled: true,
    });
    expect(deniedDrill.status).toBe(403);
    const drill = await setDrillVisibility(
      new NextRequest("http://127.0.0.1:3001/internal/drill-visibility", {
        method: "POST",
        headers: {
          authorization: "Bearer isolated-test-shop-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      }),
    );
    expect(drill.status).toBe(200);
    expect((await drill.json()).drill_visible).toBe(true);
    const unauthenticatedStop = await setDrillVisibility(
      new NextRequest("http://127.0.0.1:3001/internal/drill-visibility", {
        method: "POST",
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(unauthenticatedStop.status).toBe(401);
    expect((await get("scenarios")).body.scenarios).toEqual({ attack: false });
    expect(
      (await get("search_products", { query: "reward voucher" })).body[0].sku,
    ).toBe("REWARD-GIFT-500");
    await post("add_to_cart", {
      sku: "NOVA-Q3-BLK",
      qty: 1,
      options: { colour: "Black", size: "One size" },
    });
    await post("set_price", { sku: "NOVA-Q3-BLK", amount: 23_900 });
    const activeReset = await post("reset");
    expect(activeReset).toEqual({ status: 200, body: { ok: true } });
    expect((await get("get_cart")).body.cart.items).toEqual([]);
    expect(
      (await get("get_product", { sku: "NOVA-Q3-BLK" })).body.price.amount,
    ).toBe(27_900);
    expect(
      (await get("search_products", { query: "reward voucher" })).body[0].sku,
    ).toBe("REWARD-GIFT-500");
    const stop = await setDrillVisibility(
      new NextRequest("http://127.0.0.1:3001/internal/drill-visibility", {
        method: "POST",
        headers: {
          authorization: "Bearer isolated-test-shop-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(stop.status).toBe(200);
    expect((await stop.json()).drill_visible).toBe(false);
    expect(await post("reset")).toEqual({ status: 200, body: { ok: true } });
    expect(
      (await get("search_products", { query: "reward voucher" })).body,
    ).toEqual([]);
    const wrong = await post("add_to_cart", {
      sku: "NOVA-Q3-BLK",
      qty: 1,
      options: { colour: "Stone", size: "One size" },
    });
    expect(wrong.status).toBe(400);
    const cart = await post("add_to_cart", {
      sku: "NOVA-Q3-STN",
      qty: 1,
      options: { colour: "Stone", size: "One size" },
    });
    expect(cart.status).toBe(200);
    expect(cart.body.cart.items[0].sku).toBe("NOVA-Q3-STN");
    expect(cart.body.cart.items[0].unit_price.display).toBe("¥279.00");
    expect(cart.body.cart.total.display).toBe("¥279.00");
    expect(cart.body.cart).toMatchObject({
      shop: "shopA",
      shop_name: "BaoTao Shop",
      items: [{ product: { shop: "shopA", shop_name: "BaoTao Shop" } }],
    });
    const readCart = await get("get_cart");
    expect(readCart.body.cart).toMatchObject({
      shop: "shopA",
      shop_name: "BaoTao Shop",
    });
    const noAddress = await post("checkout");
    expect(noAddress.status).toBe(400);
    const placed = await post("checkout", { shipping_address });
    expect(placed.status).toBe(200);
    expect(placed.body).toMatchObject({
      shop: "shopA",
      shop_name: "BaoTao Shop",
      wallet_submission: "not_performed_by_shop",
      wallet_submission_message:
        "Checkout signed a merchant request; it did not create a WeBank approval or payment.",
    });
    expect(placed.body.total.display).toBe("¥284.00");
    const request = decodePaymentUri(placed.body.payment_request);
    expect(request.merchant_id).toBe("mch_shopA");
    expect(request).not.toHaveProperty("shop_name");
    expect(request).not.toHaveProperty("shop");
    expect(request.amount.amount).toBe(28_400);
    expect(request.amount).toEqual({ amount: 28_400, currency: "CNY" });
    expect(request.line_items).toMatchObject([
      {
        type: "product",
        sku: "NOVA-Q3-STN",
        gtin: "6901234567003",
        variant: "Stone",
      },
      {
        type: "shipping",
        qty: 1,
        unit_price: { amount: 500, currency: "CNY" },
      },
    ]);
    expect(verifyLocalPaymentUri(placed.body.payment_request)).toBe(true);
    const order = await GET(
      new NextRequest(
        `${base}?operation=get_order&order_id=${placed.body.order_id}`,
      ),
    );
    expect(order.status).toBe(200);
    const orderBody = await order.json();
    expect(orderBody.shipping_address).toEqual(shipping_address);
    expect(orderBody).toMatchObject({
      shop: "shopA",
      shop_name: "BaoTao Shop",
    });
    expect(orderBody.total.display).toBe("¥284.00");
    expect(orderBody.shipping_fee.display).toBe("¥5.00");
    expect(orderBody.items[0].unit_price.display).toBe("¥279.00");
  });
});
