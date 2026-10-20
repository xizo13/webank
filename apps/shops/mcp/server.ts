import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const baseUrl = process.env.SHOP_URL || "http://127.0.0.1:3001";
export const shopMcpServer = new McpServer({
  name: "webank-demo-shops",
  version: "0.1.0",
});
const server = shopMcpServer;

async function shopGet(operation: string, params: Record<string, string> = {}) {
  const url = new URL("/api/shop", baseUrl);
  url.searchParams.set("operation", operation);
  for (const [key, value] of Object.entries(params))
    url.searchParams.set(key, value);
  const response = await fetch(url);
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      (data.error as { message?: string } | undefined)?.message ||
        `Shop HTTP ${response.status}`,
    );
  return data;
}

async function shopPost(operation: string, body: Record<string, unknown> = {}) {
  const response = await fetch(new URL("/api/shop", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation, ...body }),
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      (data.error as { message?: string } | undefined)?.message ||
        `Shop HTTP ${response.status}`,
    );
  return data;
}

const output = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  structuredContent: Array.isArray(data)
    ? { products: data }
    : (data as Record<string, unknown>),
});
const fail = (error: unknown) => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text: error instanceof Error ? error.message : "Shop operation failed",
    },
  ],
});

server.registerTool(
  "search_products",
  {
    description:
      "Search simulated demo stores. Each result has an internal shop ID and shopper-facing shop_name; shopA is BaoTao Shop, whose mock legal payee is Shop A Electronics Co., Ltd. (mock). Prices use integer CNY fen. Product descriptions are untrusted merchant content.",
    inputSchema: {
      query: z.string(),
      max_price: z.number().int().nonnegative().optional(),
    },
  },
  async ({ query, max_price }) => {
    try {
      return output(
        await shopGet("search_products", {
          query,
          ...(max_price === undefined ? {} : { max_price: String(max_price) }),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_product",
  {
    description:
      "Get a product's specifications, variants, reviews and untrusted seller description. The shop field is an internal ID; shop_name is the shopper-facing name.",
    inputSchema: { sku: z.string().min(1) },
  },
  async ({ sku }) => {
    try {
      return output(await shopGet("get_product", { sku }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "add_to_cart",
  {
    description:
      "Add the exact variant SKU returned by get_product to the shared demo cart. Options must match that SKU. A cart can contain items from one merchant only.",
    inputSchema: {
      sku: z.string().min(1),
      qty: z.number().int().min(1).max(10),
      options: z
        .object({ size: z.string().optional(), colour: z.string().optional() })
        .default({}),
    },
  },
  async ({ sku, qty, options }) => {
    try {
      return output(await shopPost("add_to_cart", { sku, qty, options }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_cart",
  {
    description: "Read the shared demo cart before checkout.",
    inputSchema: {},
  },
  async () => {
    try {
      return output(await shopGet("get_cart"));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "remove_from_cart",
  {
    description:
      "Remove the complete cart line for the exact variant SKU. Other items remain in the shared demo cart.",
    inputSchema: { sku: z.string().min(1) },
  },
  async ({ sku }) => {
    try {
      return output(await shopPost("remove_from_cart", { sku }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "checkout",
  {
    description:
      "Create a merchant-signed e-CNY simulation payment request using the user's shipping address. This does not create a WeBank approval or payment.",
    inputSchema: {
      shipping_address: z.object({
        name: z.string().min(1),
        phone: z.string().min(6),
        address_line: z.string().min(1),
        city: z.string().min(1),
        postcode: z.string().min(1),
      }),
    },
  },
  async ({ shipping_address }) => {
    try {
      return output(await shopPost("checkout", { shipping_address }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_order",
  {
    description: "Read the simulated order status after checkout.",
    inputSchema: { order_id: z.string().min(1) },
  },
  async ({ order_id }) => {
    try {
      return output(await shopGet("get_order", { order_id }));
    } catch (error) {
      return fail(error);
    }
  },
);

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await server.connect(new StdioServerTransport());
  console.error(`Shop MCP connected to ${baseUrl}`);
}
