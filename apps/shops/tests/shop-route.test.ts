import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET, POST } from "../app/api/shop/route";
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
});
beforeEach(() => resetDemo());
afterAll(() => {
  delete process.env.SHOP_DATA_DIR;
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
    expect(
      (await get("search_products", { query: "reward voucher" })).body,
    ).toEqual([]);
    const drill = await post("set_scenario", {
      scenario: "drill",
      enabled: true,
    });
    expect(drill.body.scenarios.drill).toBe(true);
    expect(
      (await get("search_products", { query: "reward voucher" })).body[0].sku,
    ).toBe("REWARD-GIFT-500");
    await post("set_scenario", { scenario: "drill", enabled: false });
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
    const noAddress = await post("checkout");
    expect(noAddress.status).toBe(400);
    const placed = await post("checkout", { shipping_address });
    expect(placed.status).toBe(200);
    expect(placed.body.total.display).toBe("¥284.00");
    const request = decodePaymentUri(placed.body.payment_request);
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
    expect(orderBody.total.display).toBe("¥284.00");
    expect(orderBody.shipping_fee.display).toBe("¥5.00");
    expect(orderBody.items[0].unit_price.display).toBe("¥279.00");
  });
});
