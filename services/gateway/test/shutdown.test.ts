import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DurableState } from "../src/durable-state.js";

describe("Gateway normal shutdown", () => {
  it("releases the owned lock before process exit so a new writer starts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "webank-shutdown-"));
    const statePath = join(directory, "gateway.json");
    const loader = fileURLToPath(
      new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
    );
    const fixture = fileURLToPath(
      new URL("./fixtures/shutdown-child.ts", import.meta.url),
    );
    const child = spawn(process.execPath, ["--import", loader, fixture], {
      env: { ...process.env, WEBANK_TEST_STATE_PATH: statePath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = "";
        let errors = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("READY\n")) resolve();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          errors += chunk.toString();
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`Child exited ${code}: ${errors}`)),
        );
      });
      expect(existsSync(`${statePath}.lock`)).toBe(true);
      child.kill("SIGTERM");
      const code = await new Promise<number | null>((resolve) =>
        child.once("exit", resolve),
      );
      expect(code).toBe(0);
      expect(existsSync(`${statePath}.lock`)).toBe(false);
      const next = new DurableState<{ ready: boolean }>(statePath);
      expect(next.load()).toEqual({ ready: true });
      next.close();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
