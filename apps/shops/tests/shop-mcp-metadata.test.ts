import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";

it("describes the shop name and checkout boundary to MCP clients", async () => {
  const client = new Client({ name: "shop-metadata-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "mcp/server.ts"],
    cwd: resolve(import.meta.dirname, ".."),
    env: process.env,
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(
      tools.find((tool) => tool.name === "search_products")?.description,
    ).toContain("shopA is BaoTao Shop");
    expect(
      tools.find((tool) => tool.name === "search_products")?.description,
    ).toContain("does not schedule a price watch");
    expect(
      tools.find((tool) => tool.name === "checkout")?.description,
    ).toContain("This does not create a WeBank approval or payment");
  } finally {
    await client.close();
  }
});
