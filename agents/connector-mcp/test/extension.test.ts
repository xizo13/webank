import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";

it("installs the self-contained extension in another directory and lists its MCP tools", async () => {
  const root = resolve(import.meta.dirname, "..");
  const archive = join(root, "release", "webank-agent-wallet-0.1.0.mcpb");
  execFileSync("node", [join(root, "scripts", "build-extension.mjs")], {
    cwd: root,
  });
  const directory = mkdtempSync(join(tmpdir(), "webank-extension-test-"));
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(directory, "server", "index.mjs")],
    cwd: tmpdir(),
    env: {
      ...process.env,
      WEBANK_CONNECTOR_CREDENTIALS: join(directory, "credentials.json"),
      WEBANK_GATEWAY_URL: "http://127.0.0.1:1",
    },
  });
  const client = new Client({ name: "extension-test", version: "0.1.0" });
  try {
    execFileSync("unzip", ["-q", archive, "-d", directory]);
    const manifest = JSON.parse(
      readFileSync(join(directory, "manifest.json"), "utf8"),
    );
    expect(manifest.server.entry_point).toBe("server/index.mjs");
    expect(manifest.server.mcp_config.args).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: MCPB expands this manifest placeholder.
      "${__dirname}/server/index.mjs",
    ]);
    const notices = readFileSync(
      join(directory, "notices", "THIRD_PARTY_NOTICES.txt"),
      "utf8",
    );
    for (const packageName of [
      "@modelcontextprotocol/sdk",
      "zod",
      "fast-uri",
    ]) {
      const entry = notices
        .split("\n")
        .find((line) => line.startsWith(`${packageName}@`));
      expect(entry).toBeDefined();
      const license = join(
        directory,
        "notices",
        "licenses",
        encodeURIComponent(entry?.split(" ")[0] ?? ""),
        "LICENSE",
      );
      expect(readFileSync(license, "utf8").length).toBeGreaterThan(100);
    }
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name).sort()).toEqual(
      manifest.tools.map(({ name }: { name: string }) => name).sort(),
    );
    const status = await client.callTool({
      name: "get_wallet_status",
      arguments: {},
    });
    expect(status.structuredContent).toMatchObject({ state: "not_paired" });
  } finally {
    await client.close().catch(() => undefined);
    rmSync(directory, { recursive: true, force: true });
  }
});
