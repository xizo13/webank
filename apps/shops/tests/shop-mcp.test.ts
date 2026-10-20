import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, it } from "vitest";
import { GET, POST } from "../app/api/shop/route";
import { POST as setDrillVisibility } from "../app/internal/drill-visibility/route";
import { decodePaymentUri, verifyLocalPaymentUri } from "../lib/signing";
import { resetDemo } from "../lib/store";

const dataDir = mkdtempSync(join(tmpdir(), "webank-shop-mcp-"));
const shopDir = resolve(import.meta.dirname, "..");
let httpServer: Server;
let client: Client;
let baseUrl: string;

beforeAll(async () => {
  process.env.SHOP_DATA_DIR = dataDir;
  process.env.SHOP_INTERNAL_TOKEN = "isolated-test-shop-token";
  resetDemo({ clearDrill: true });
  httpServer = createServer(async (incoming, outgoing) => {
    const body: Buffer[] = [];
    for await (const chunk of incoming) body.push(Buffer.from(chunk));
    const request = new NextRequest(`${baseUrl}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers as Record<string, string>,
      ...(body.length ? { body: Buffer.concat(body) } : {}),
    });
    const response =
      incoming.method === "POST"
        ? incoming.url === "/internal/drill-visibility"
          ? await setDrillVisibility(request)
          : await POST(request)
        : await GET(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((ready) => httpServer.listen(0, "127.0.0.1", ready));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "mcp/server.ts"],
    cwd: shopDir,
    env: { ...process.env, SHOP_URL: baseUrl },
  });
  client = new Client({ name: "shop-acceptance", version: "1.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  if (httpServer)
    await new Promise<void>((done) => httpServer.close(() => done()));
  delete process.env.SHOP_DATA_DIR;
  delete process.env.SHOP_INTERNAL_TOKEN;
  rmSync(dataDir, { recursive: true, force: true });
});

async function tool(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as Record<string, unknown>;
}

async function scenario(name: "attack" | "drill", enabled: boolean) {
  const internal = name === "drill";
  const response = await fetch(
    `${baseUrl}${internal ? "/internal/drill-visibility" : "/api/shop"}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(internal
          ? { authorization: "Bearer isolated-test-shop-token" }
          : {}),
      },
      body: JSON.stringify(
        internal
          ? { enabled }
          : {
              operation: "set_scenario",
              scenario: name,
              enabled,
            },
      ),
    },
  );
  expect(response.status).toBe(200);
}

it("shows ranked prices and gated attack listings through the shop MCP tools", async () => {
  const tools = await client.listTools();
  expect(tools.tools.map((entry) => entry.name)).not.toContain("set_scenario");
  expect(tools.tools.map((entry) => entry.name)).not.toContain(
    "start_fire_drill",
  );
  const initial = (await tool("search_products", { query: "Nova Quiet 2" }))
    .products as Array<Record<string, unknown>>;
  expect(initial.map((item) => [item.sku, item.match])).toEqual([
    ["NOVA-Q2-BLK", "exact"],
    ["NOVA-Q3-BLK", "related"],
  ]);
  expect(initial[0].price).toEqual({
    amount: 21_900,
    currency: "CNY",
    display: "¥219.00",
  });
  expect(initial[0]).toMatchObject({
    shop: "shopA",
    shop_name: "BaoTao Shop",
  });
  expect((await tool("get_product", { sku: "NOVA-Q2-BLK" })).price).toEqual(
    initial[0].price,
  );
  expect(await tool("get_product", { sku: "NOVA-Q2-BLK" })).toMatchObject({
    shop: "shopA",
    shop_name: "BaoTao Shop",
  });
  expect(
    (await tool("search_products", { query: "reward voucher" })).products,
  ).toEqual([]);
  await expect(tool("get_product", { sku: "REWARD-GIFT-500" })).rejects.toThrow(
    "Product not found",
  );

  await scenario("attack", true);
  const attack = (await tool("search_products", { query: "Nova Quiet 2" }))
    .products as Array<Record<string, unknown>>;
  expect(attack.map((item) => [item.sku, item.match])).toEqual([
    ["NOVA-Q2-BLK", "exact"],
    ["NOVA-Q3-BLK", "related"],
    ["FLASH-Q3-FEE", "related"],
  ]);
  expect(
    (await tool("search_products", { query: "reward voucher" })).products,
  ).toEqual([]);
  await expect(tool("get_product", { sku: "REWARD-GIFT-500" })).rejects.toThrow(
    "Product not found",
  );
  await scenario("attack", false);
  expect(
    (await tool("search_products", { query: "reward voucher" })).products,
  ).toEqual([]);

  await scenario("drill", true);
  const drill = (await tool("search_products", { query: "reward voucher" }))
    .products as Array<Record<string, unknown>>;
  expect(drill[0]).toMatchObject({ sku: "REWARD-GIFT-500", match: "exact" });
  expect(
    (await tool("search_products", { query: "priority dispatch" })).products,
  ).toEqual([]);
  await scenario("drill", false);
  expect(
    (await tool("search_products", { query: "reward voucher" })).products,
  ).toEqual([]);

  const cart = (
    await tool("add_to_cart", {
      sku: "NOVA-Q3-BLK",
      qty: 1,
      options: { colour: "Black", size: "One size" },
    })
  ).cart as Record<string, unknown>;
  expect(cart.total).toEqual({
    amount: 27_900,
    currency: "CNY",
    display: "¥279.00",
  });
  const readCart = (await tool("get_cart", {})).cart as Record<string, unknown>;
  expect(readCart.total).toEqual(cart.total);
  expect(readCart).toMatchObject({
    shop: "shopA",
    shop_name: "BaoTao Shop",
  });
  const removed = (await tool("remove_from_cart", { sku: "NOVA-Q3-BLK" }))
    .cart as Record<string, unknown>;
  expect(removed.items).toEqual([]);
  expect(removed.total).toEqual({
    amount: 0,
    currency: "CNY",
    display: "¥0.00",
  });
  await tool("add_to_cart", {
    sku: "NOVA-Q3-BLK",
    qty: 1,
    options: { colour: "Black", size: "One size" },
  });
  const order = await tool("checkout", {
    shipping_address: {
      name: "Lin Demo",
      phone: "13800138000",
      address_line: "88 Demo Road",
      city: "Shenzhen",
      postcode: "518000",
    },
  });
  expect(order.total).toEqual({
    amount: 28_400,
    currency: "CNY",
    display: "¥284.00",
  });
  expect(order).toMatchObject({
    shop: "shopA",
    shop_name: "BaoTao Shop",
    wallet_submission: "not_performed_by_shop",
  });
  const signed = order.payment_request as string;
  expect(verifyLocalPaymentUri(signed)).toBe(true);
  expect(decodePaymentUri(signed).line_items[0]).toMatchObject({
    sku: "NOVA-Q3-BLK",
    variant: "Black",
    options: { colour: "Black", size: "One size" },
  });
  const fetchedOrder = await tool("get_order", {
    order_id: order.order_id,
  });
  expect(fetchedOrder.total).toEqual(order.total);
  expect(fetchedOrder).toMatchObject({
    shop: "shopA",
    shop_name: "BaoTao Shop",
  });
  expect(fetchedOrder.shipping_fee).toEqual({
    amount: 500,
    currency: "CNY",
    display: "¥5.00",
  });
});
