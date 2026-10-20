import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  requiredLoginTokenPath,
  writePrivateLoginToken,
} from "../src/private-login-token.js";

const gatewayDir = fileURLToPath(new URL("..", import.meta.url));
const loader = fileURLToPath(
  new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
);

function runGateway(entry: string, env: Record<string, string>) {
  const childEnv = { ...process.env, NODE_ENV: "development" };
  delete childEnv.WEBANK_LOCAL_DEMO_TOKEN_FILE;
  delete childEnv.WEBANK_DEMO_TOKEN_FILE;
  return spawnSync(process.execPath, ["--import", loader, entry], {
    cwd: gatewayDir,
    env: { ...childEnv, ...env },
    encoding: "utf8",
    timeout: 6_000,
  });
}

describe("standalone Gateway login tokens", () => {
  it.each([
    [
      "src/local-demo-server.ts",
      "WEBANK_LOCAL_DEMO_TOKEN_FILE",
      { WEBANK_LOCAL_DEMO: "1", WEBANK_DEMO_APPROVALS: "1" },
    ],
    [
      "src/demo-server.ts",
      "WEBANK_DEMO_TOKEN_FILE",
      { WEBANK_DEMO_SERVER: "1" },
    ],
  ])(
    "refuses %s before listening without a private token path",
    (entry, name, flags) => {
      const env = { ...flags } as Record<string, string>;
      delete env[name];
      const result = runGateway(entry, env);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${name} must be an absolute path`);
      expect(result.stdout).not.toContain("login token:");
      expect(result.stdout).not.toContain("listening at");
    },
  );

  it("creates only a new regular mode 0600 token file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-private-token-"));
    try {
      const path = join(directory, "login-token");
      await writePrivateLoginToken(path, "synthetic-test-token");
      expect(readFileSync(path, "utf8")).toBe("synthetic-test-token\n");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      await expect(
        writePrivateLoginToken(path, "replacement"),
      ).rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe("synthetic-test-token\n");
      const link = join(directory, "login-link");
      symlinkSync(path, link);
      await expect(
        writePrivateLoginToken(link, "replacement"),
      ).rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe("synthetic-test-token\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("starts the mock fixture with a private token and no stdout token", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-demo-token-"));
    try {
      const path = join(directory, "login-token");
      const result = runGateway("src/demo-server.ts", {
        WEBANK_DEMO_SERVER: "1",
        WEBANK_DEMO_PORT: "39879",
        WEBANK_DEMO_TOKEN_FILE: path,
      });
      const token = readFileSync(path, "utf8").trim();
      expect(token.length).toBeGreaterThan(20);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(result.stdout).not.toContain(token);
      expect(result.stderr).not.toContain(token);
      expect(result.stderr).not.toContain("Failed to seed demo pairing");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("rejects absent or relative token paths", () => {
    const name = "WEBANK_TEST_PRIVATE_TOKEN_FILE";
    const previous = process.env[name];
    try {
      delete process.env[name];
      expect(() => requiredLoginTokenPath(name)).toThrow();
      process.env[name] = "relative/token";
      expect(() => requiredLoginTokenPath(name)).toThrow();
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });
});
