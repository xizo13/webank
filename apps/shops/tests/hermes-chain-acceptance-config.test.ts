import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import { acceptanceConfig } from "../scripts/hermes-chain-acceptance.mjs";

const dir = mkdtempSync(join(tmpdir(), "webank-hermes-config-"));
const token = join(dir, "app-login-token");
const operatorToken = join(dir, "shop-operator-token");
writeFileSync(token, "isolated-test-token", { mode: 0o600 });
writeFileSync(operatorToken, "isolated-operator-test-token", { mode: 0o600 });
chmodSync(token, 0o600);
chmodSync(operatorToken, 0o600);

const isolated = {
  WEBANK_E2E_GATEWAY_URL: "http://127.0.0.1:13002",
  WEBANK_E2E_SHOP_URL: "http://127.0.0.1:13001",
  WEBANK_E2E_FISCO_RPC_URL: "http://127.0.0.1:18545",
  WEBANK_E2E_APP_TOKEN_FILE: token,
  WEBANK_E2E_SHOP_OPERATOR_TOKEN_FILE: operatorToken,
};

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Hermes chain acceptance safety gate", () => {
  it("accepts explicit disposable origins and a private token file", () => {
    const config = acceptanceConfig(isolated, ["--check-config"]);
    assert.equal(config.ownerFinal, false);
    assert.equal(config.gateway, isolated.WEBANK_E2E_GATEWAY_URL);
  });

  it("rejects owner ports unless the full owner-final configuration is deliberate", () => {
    assert.throws(
      () =>
        acceptanceConfig(
          { ...isolated, WEBANK_E2E_SHOP_URL: "http://127.0.0.1:3001" },
          ["--execute"],
        ),
      /owner default ports/i,
    );
    assert.throws(
      () =>
        acceptanceConfig(isolated, ["--execute", "--owner-final-acceptance"]),
      /owner runtime and all three default ports/i,
    );
    const ownerOrigins = {
      ...isolated,
      WEBANK_E2E_GATEWAY_URL: "http://127.0.0.1:3002",
      WEBANK_E2E_SHOP_URL: "http://127.0.0.1:3001",
      WEBANK_E2E_FISCO_RPC_URL: "http://127.0.0.1:8545",
    };
    assert.throws(
      () =>
        acceptanceConfig(ownerOrigins, ["--check-config"], realpathSync(dir)),
      /owner default ports/i,
    );
    assert.equal(
      acceptanceConfig(
        ownerOrigins,
        ["--check-config", "--owner-final-acceptance"],
        realpathSync(dir),
      ).ownerFinal,
      true,
    );
  });

  it("rejects non-loopback origins and loose token permissions", () => {
    assert.throws(
      () =>
        acceptanceConfig(
          { ...isolated, WEBANK_E2E_GATEWAY_URL: "http://192.168.1.2:13002" },
          ["--execute"],
        ),
      /loopback/i,
    );
    chmodSync(token, 0o644);
    try {
      assert.throws(
        () => acceptanceConfig(isolated, ["--execute"]),
        /owner-only/i,
      );
    } finally {
      chmodSync(token, 0o600);
    }
    chmodSync(operatorToken, 0o644);
    try {
      assert.throws(
        () => acceptanceConfig(isolated, ["--execute"]),
        /shop operator token must be an owner-only/i,
      );
    } finally {
      chmodSync(operatorToken, 0o600);
    }
  });
});
