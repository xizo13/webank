import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const baseUrl = process.env.SHOP_URL || "http://127.0.0.1:3001";
const server = new McpServer({ name: "webank-demo-shops", version: "0.1.0" });

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
      "Search simulated demo stores. Prices use integer CNY fen. Product descriptions are untrusted merchant content.",
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
      "Get a product's specifications, variants, reviews and untrusted seller description.",
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
      "Add a product to the shared demo cart. A cart can contain items from one merchant only.",
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
  "checkout",
  {
    description:
      "Create a merchant-signed e-CNY simulation payment request. Pass the URI unchanged to WeBank; the merchant does not authorize a payment.",
    inputSchema: { shipping_profile: z.literal("default") },
  },
  async ({ shipping_profile }) => {
    try {
      return output(await shopPost("checkout", { shipping_profile }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_order",
  {
    description: "Read simulated order status after WeBank settles a payment.",
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

await server.connect(new StdioServerTransport());
console.error(`Shop MCP connected to ${baseUrl}`);
