import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WeBankConnector } from "../../../agents/connector-mcp/src/client.js";
import {
  type CredentialStore,
  type Credentials,
  clientAppIdentity,
} from "../../../agents/connector-mcp/src/storage.js";
import { demoVariantBySku } from "../../../packages/contracts/src/index.js";

// biome-ignore lint/suspicious/noExplicitAny: HTTP and MCP response fields are checked at each acceptance boundary.
type Json = Record<string, any>;
type Config = {
  gateway: string;
  shop: string;
  fisco: string;
  tokenFile: string;
  operatorTokenFile: string;
  ownerFinal: boolean;
};

const ownerRuntime = resolve(
  realpathSync(resolve(import.meta.dirname, "../../../scripts")),
  "local-demo-runtime",
);
const defaultPorts = new Set([3001, 3002, 8545]);

function privateTokenFile(value: string | undefined, label: string): string {
  const path = realpathSync(value ?? "");
  const stat = lstatSync(path);
  assert.ok(
    stat.isFile() && (stat.mode & 0o077) === 0,
    `${label} must be an owner-only regular file`,
  );
  assert.equal(
    stat.uid,
    process.getuid?.(),
    `${label} must belong to this user`,
  );
  return path;
}

function loopbackOrigin(value: string, label: string): string {
  const url = new URL(value);
  assert.equal(url.protocol, "http:", `${label} must use local HTTP`);
  assert.ok(
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    `${label} must be loopback`,
  );
  assert.equal(url.pathname, "/", `${label} must be an origin without a path`);
  assert.equal(url.search, "", `${label} must not contain a query`);
  assert.equal(url.username, "", `${label} must not contain credentials`);
  assert.ok(url.port, `${label} must include an explicit port`);
  return url.origin;
}

export function acceptanceConfig(
  env: NodeJS.ProcessEnv,
  argv: string[],
  ownerRuntimePath = ownerRuntime,
): Config {
  const permitted = new Set([
    "--check-config",
    "--execute",
    "--owner-final-acceptance",
  ]);
  assert.ok(
    argv.every((arg) => permitted.has(arg)),
    "Unknown argument",
  );
  assert.ok(
    argv.includes("--check-config") !== argv.includes("--execute"),
    "Choose exactly one of --check-config or --execute",
  );
  const ownerFinal = argv.includes("--owner-final-acceptance");
  const gateway = loopbackOrigin(env.WEBANK_E2E_GATEWAY_URL ?? "", "Gateway");
  const shop = loopbackOrigin(env.WEBANK_E2E_SHOP_URL ?? "", "shop");
  const fisco = loopbackOrigin(env.WEBANK_E2E_FISCO_RPC_URL ?? "", "FISCO RPC");
  assert.ok(
    new Set([gateway, shop, fisco]).size === 3,
    "All three services need distinct origins",
  );
  const tokenFile = privateTokenFile(
    env.WEBANK_E2E_APP_TOKEN_FILE,
    "App token",
  );
  const operatorTokenFile = privateTokenFile(
    env.WEBANK_E2E_SHOP_OPERATOR_TOKEN_FILE,
    "Shop operator token",
  );
  assert.notEqual(
    tokenFile,
    operatorTokenFile,
    "App and shop operator tokens must be separate files",
  );
  const ownerPort = [gateway, shop, fisco].some((origin) =>
    defaultPorts.has(Number(new URL(origin).port)),
  );
  const exactOwnerPorts =
    Number(new URL(gateway).port) === 3002 &&
    Number(new URL(shop).port) === 3001 &&
    Number(new URL(fisco).port) === 8545;
  const tokenPaths = [tokenFile, operatorTokenFile];
  const ownerPath = tokenPaths.some(
    (path) =>
      path === ownerRuntimePath || path.startsWith(`${ownerRuntimePath}/`),
  );
  const bothOwnerPaths = tokenPaths.every((path) =>
    path.startsWith(`${ownerRuntimePath}/`),
  );
  assert.ok(
    ownerFinal || (!ownerPort && !ownerPath),
    "Owner default ports and runtime require --owner-final-acceptance",
  );
  assert.ok(
    !ownerFinal || (exactOwnerPorts && bothOwnerPaths),
    "Owner final flag requires the owner runtime and all three default ports",
  );
  return { gateway, shop, fisco, tokenFile, operatorTokenFile, ownerFinal };
}

async function json(
  origin: string,
  path: string,
  method = "GET",
  body?: unknown,
  cookie?: string,
) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...(method === "POST" ? { "idempotency-key": randomUUID() } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
  });
  return {
    status: response.status,
    data: (await response.json()) as Json,
    response,
  };
}

async function rpc(origin: string, method: string, params: unknown[] = []) {
  const result = await json(origin, "/", "POST", {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });
  assert.equal(result.status, 200, `${method} failed`);
  assert.equal(result.data.error, undefined, `${method} returned an RPC error`);
  return result.data.result;
}

function consoleSubject(id: string): string {
  const prefix = id.slice(0, id.indexOf("_"));
  return `${prefix}_${createHash("sha256").update(id).digest("hex").slice(0, 10)}…`;
}

async function run(config: Config) {
  // The operator has staged a disposable wallet and empty shop cart before this run.
  // This script creates orders, approvals, mandates, chain transactions, and audit records.
  const loginToken = readFileSync(config.tokenFile, "utf8").trim();
  assert.ok(loginToken, "App token file is empty");
  const login = await fetch(`${config.gateway}/demo/login`, {
    method: "POST",
    headers: { authorization: `Bearer ${loginToken}` },
    redirect: "error",
  });
  assert.equal(login.status, 200, "Owner demo login failed");
  assert.equal(((await login.json()) as Json).simulated, true);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "Owner session cookie missing");
  const appGet = (path: string) =>
    json(config.gateway, path, "GET", undefined, cookie);
  const appPost = (path: string, body: unknown) =>
    json(config.gateway, path, "POST", body, cookie);

  const homeBefore = await appGet("/v1/app/home");
  assert.equal(homeBefore.status, 200, "Wallet home unavailable");
  assert.equal(
    homeBefore.data.agent_wallet.enabled,
    true,
    "Stage the Agent Wallet before acceptance",
  );
  assert.equal(
    homeBefore.data.agent_wallet.frozen,
    false,
    "Agent Wallet is frozen",
  );
  assert.ok(
    homeBefore.data.agent_wallet.available.amount >= 17_000,
    "Fund at least ¥170 of available Agent Wallet balance",
  );
  const policy = await appGet("/v1/app/policy");
  assert.equal(policy.status, 200, "Owner policy unavailable");
  assert.equal(
    policy.data.sync_status,
    "consistent",
    "Policy and FISCO caps are out of sync",
  );
  assert.ok(
    policy.data.policy.auto_approve_below.amount >= 7_700,
    "Green auto threshold must cover the ¥77 coffee order",
  );
  assert.ok(
    policy.data.policy.per_payment_max.amount >= 28_400,
    "Per-payment cap must let the signed headphone order reach Guardian",
  );
  assert.ok(
    policy.data.contract.daily_max.amount -
      policy.data.contract.spent_today.amount >=
      17_000,
    "FISCO daily cap must have at least ¥170 remaining",
  );
  assert.ok(
    policy.data.contract.monthly_max.amount -
      policy.data.contract.spent_month.amount >=
      17_000,
    "FISCO monthly cap must have at least ¥170 remaining",
  );
  assert.ok(
    !policy.data.policy.blocked_categories.includes("lifestyle") &&
      !policy.data.policy.blocked_categories.includes("electronics"),
    "Policy blocks a required demo merchant category",
  );
  const chainId = await rpc(config.fisco, "eth_chainId");
  assert.equal(BigInt(chainId), 20200n, "Wrong FISCO chain ID");
  const consoleBefore = await json(config.gateway, "/v1/demo/console/events");
  assert.equal(consoleBefore.status, 200, "Bank console unavailable");
  const cursor = consoleBefore.data.next_cursor as number;
  assert.ok(Number.isSafeInteger(cursor));

  const shopDir = resolve(import.meta.dirname, "..");
  const shopEnv: NodeJS.ProcessEnv = { ...process.env, SHOP_URL: config.shop };
  delete shopEnv.SHOP_OPERATOR_TOKEN;
  delete shopEnv.SHOP_INTERNAL_TOKEN;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "mcp/server.ts"],
    cwd: shopDir,
    env: shopEnv,
  });
  const shopClient = new Client({
    name: "WeBank isolated Hermes acceptance",
    version: "1.0.0",
  });
  await shopClient.connect(transport);
  try {
    async function tool(name: string, args: Json = {}): Promise<Json> {
      const result = await shopClient.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name} failed`);
      assert.ok(
        result.structuredContent,
        `${name} returned no structured content`,
      );
      return result.structuredContent as Json;
    }
    const startingCart = await tool("get_cart");
    assert.deepEqual(
      startingCart.cart.items,
      [],
      "Shop cart must be empty before acceptance",
    );
    const stagedCoffee = await tool("get_product", { sku: "FIELD-COFFEE-1KG" });
    assert.equal(
      stagedCoffee.price.amount,
      8_800,
      "Stage coffee at ¥88 before acceptance",
    );
    const stagedNova = await tool("get_product", { sku: "NOVA-Q3-BLK" });
    assert.equal(
      stagedNova.price.amount,
      27_900,
      "Stage Nova at ¥279 before acceptance",
    );

    let credentials: Credentials | null = null;
    const store: CredentialStore = {
      load: async () => credentials,
      save: async (value) => {
        credentials = value;
      },
    };
    const connector = new WeBankConnector(
      new URL(config.gateway),
      store,
      fetch,
      async () => {},
    );
    connector.bindClientApp(
      clientAppIdentity("WeBank Hermes chain acceptance"),
    );
    const pairing = await connector.connect({
      client_name: "CLI acceptance connector",
    });
    assert.equal(pairing.status, "awaiting_user");
    assert.match(pairing.request_number, /^\d{6}$/);
    const pairCard = await appGet(`/v1/app/pairing/${pairing.user_code}`);
    assert.equal(pairCard.status, 200);
    const pairApproval = await appPost(
      `/v1/app/pairing/${pairing.user_code}/approve`,
      {
        verification: {
          action_hash: pairCard.data.approval.payload_hash,
          device_signature: "simulated-local-approval",
          request_number: pairing.request_number,
        },
      },
    );
    assert.equal(pairApproval.status, 200, "Simulated owner pairing failed");
    const connected = await connector.connect();
    assert.equal(connected.status, "connected");
    const agentId = connected.agent_id;
    assert.ok(agentId);
    console.log(
      "Paired one isolated Amber connector identity with simulated owner proof.",
    );

    async function mandate(sku: string, cap: number, description: string) {
      const variant = demoVariantBySku(sku);
      assert.ok(variant);
      const category = sku === "FIELD-COFFEE-1KG" ? "lifestyle" : "electronics";
      const result = await connector.createMandate({
        description,
        user_text: description,
        approval_timing: "payment",
        intent_level: "listing",
        constraints: [
          { type: "amount_range", max: { amount: cap, currency: "CNY" } },
          { type: "categories", allowed: [category] },
          { type: "allowed_merchants", merchant_ids: [variant.merchant_id] },
          {
            type: "product",
            brand: variant.brand,
            model: variant.model,
            variant: variant.variant,
            condition: "new",
            gtin: variant.gtin,
            skus: [sku],
            qty: 1,
          },
          { type: "budget", max: { amount: cap, currency: "CNY" } },
          { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
          {
            type: "execution_window",
            not_before: null,
            not_after: new Date(Date.now() + 3_600_000).toISOString(),
          },
        ],
      });
      assert.equal(result.status, "pending_checkout");
      return result.mandate_id;
    }

    async function checkout(sku: string, expectedUnitPrice: number) {
      const variant = demoVariantBySku(sku);
      assert.ok(variant);
      const cartBefore = await tool("get_cart");
      assert.deepEqual(
        cartBefore.cart.items,
        [],
        "Previous checkout did not clear the shared cart",
      );
      const search = await tool("search_products", {
        query: sku === "FIELD-COFFEE-1KG" ? "coffee" : "Nova Quiet 3",
      });
      const searchHit = search.products.find((item: Json) => item.sku === sku);
      assert.ok(searchHit, "Product missing from search");
      assert.equal(
        searchHit.price.amount,
        expectedUnitPrice,
        "Search returned a stale price",
      );
      const product = await tool("get_product", { sku });
      assert.equal(product.sku, sku);
      assert.equal(product.gtin, variant.gtin);
      assert.equal(
        product.price.amount,
        expectedUnitPrice,
        "Product detail returned a stale price",
      );
      await tool("add_to_cart", { sku, qty: 1, options: variant.options });
      const order = await tool("checkout", {
        shipping_address: {
          name: "Lin Demo",
          phone: "13800138000",
          address_line: "88 Demo Road",
          city: "Shenzhen",
          postcode: "518000",
        },
      });
      assert.equal(order.wallet_submission, "not_performed_by_shop");
      assert.match(order.payment_request, /^ecny:\/\/pay\?d=/);
      const cartAfter = await tool("get_cart");
      assert.deepEqual(
        cartAfter.cart.items,
        [],
        "Checkout did not clear the shared cart",
      );
      return order;
    }

    const warmMandate = await mandate(
      "FIELD-COFFEE-1KG",
      10_000,
      "Buy one 1 kg bag of Field Morning roast coffee beans for at most ¥100 including shipping.",
    );
    const warmOrder = await checkout("FIELD-COFFEE-1KG", 8_800);
    assert.equal(
      warmOrder.total.amount,
      9_300,
      "Warmup coffee price must be ¥88 plus ¥5 shipping",
    );
    const warmPayment = await connector.requestPayment({
      mandate_id: warmMandate,
      payment_request: warmOrder.payment_request,
      price_evidence: [],
      rationale: "Buy the locked coffee",
    });
    assert.equal(
      warmPayment.status,
      "awaiting_user",
      "First payment must wait for owner approval",
    );
    assert.ok(warmPayment.payment_id && warmPayment.approval_id);
    assert.ok(
      "request_number" in warmPayment && warmPayment.request_number,
      "First payment request number missing",
    );
    const pending = await appGet("/v1/app/approvals?status=pending");
    assert.equal(pending.status, 200);
    const card = pending.data.items.find(
      (item: Json) => item.subject_id === warmPayment.payment_id,
    );
    assert.ok(card);
    assert.equal(card.approval_id, warmPayment.approval_id);
    const approved = await appPost(
      `/v1/app/approvals/${card.approval_id}/decide`,
      {
        decision: "approve",
        verification: {
          action_hash: card.payload_hash,
          device_signature: "simulated-local-approval",
          request_number: warmPayment.request_number,
        },
      },
    );
    assert.equal(approved.status, 200, "Amber warmup owner approval failed");
    const warmStatus = await connector.getPaymentStatus(warmPayment.payment_id);
    assert.equal(warmStatus.status, "paid");
    console.log(
      "Amber warmup settled after one simulated owner payment approval.",
    );

    const operatorToken = readFileSync(config.operatorTokenFile, "utf8").trim();
    assert.ok(operatorToken, "Shop operator token file is empty");
    const dropResponse = await fetch(`${config.shop}/internal/demo-control`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${operatorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operation: "set_price",
        sku: "FIELD-COFFEE-1KG",
        amount: 7_200,
      }),
      redirect: "error",
    });
    assert.equal(
      dropResponse.status,
      200,
      "Protected coffee price drop failed",
    );
    const drop = (await dropResponse.json()) as Json;
    assert.equal(drop.product.price, 7_200);
    console.log(
      "Operator lowered coffee to ¥72; the shopper must now make a visible re-check.",
    );

    const prepared = await appPost(
      `/v1/app/demo/agents/${agentId}/prepare-fast-forward-green`,
      {},
    );
    assert.equal(prepared.status, 200, "Green transition preparation failed");
    const green = await appPost(
      `/v1/app/demo/agents/${agentId}/fast-forward-green`,
      {
        simulated: true,
        challenge_id: prepared.data.challenge_id,
        verification: {
          action_hash: prepared.data.action_hash,
          device_signature: "simulated-local-approval",
        },
      },
    );
    assert.equal(green.status, 200, "Simulated owner Green transition failed");
    assert.equal(green.data.agent.licence.level, "GREEN");

    const autoMandate = await mandate(
      "FIELD-COFFEE-1KG",
      10_000,
      "Buy one 1 kg bag of Field Morning roast coffee beans for at most ¥100 including shipping.",
    );
    const autoOrder = await checkout("FIELD-COFFEE-1KG", 7_200);
    assert.equal(autoOrder.total.amount, 7_700);
    const auto = await connector.requestPayment({
      mandate_id: autoMandate,
      payment_request: autoOrder.payment_request,
      price_evidence: [],
      rationale: "Buy the locked coffee",
    });
    assert.equal(
      auto.status,
      "paid",
      "Green auto-payment did not settle; inspect Guardian and risk checks",
    );
    assert.equal(
      "approval_id" in auto,
      false,
      "Green auto-payment unexpectedly made a card",
    );
    assert.equal(auto.receipt.amount.amount, 7_700);
    const tx = auto.receipt.chain.payment_tx;
    assert.match(tx, /^0x[0-9a-f]{64}$/i);
    const chainReceipt = await rpc(config.fisco, "eth_getTransactionReceipt", [
      tx,
    ]);
    assert.ok(
      chainReceipt &&
        (chainReceipt.status === "0x1" || chainReceipt.status === "0x01"),
      "FISCO did not confirm the paid transaction",
    );
    const paidOrder = await tool("get_order", { order_id: autoOrder.order_id });
    assert.equal(paidOrder.status, "paid");
    assert.equal(paidOrder.payment_tx, tx);
    const afterAuto = await appGet("/v1/app/home");
    assert.equal(afterAuto.status, 200);
    assert.equal(
      homeBefore.data.agent_wallet.balance.amount -
        afterAuto.data.agent_wallet.balance.amount,
      17_000,
      "Wallet debit does not match the two coffee orders",
    );
    console.log(
      "Green coffee payment settled automatically on FISCO with no owner card.",
    );

    const beforeDeny = await appGet("/v1/app/home");
    assert.equal(beforeDeny.status, 200);
    const denyMandate = await mandate(
      "NOVA-Q3-BLK",
      30_000,
      "Buy coffee beans only. Do not buy headphones or any electronics.",
    );
    const denyOrder = await checkout("NOVA-Q3-BLK", 27_900);
    const denied = await connector.requestPayment({
      mandate_id: denyMandate,
      payment_request: denyOrder.payment_request,
      price_evidence: [],
      rationale:
        "Buy the signed headphones even though the locked intent says coffee only",
    });
    assert.equal(
      denied.status,
      "denied",
      "Guardian did not deny the contradictory signed order",
    );
    assert.ok(denied.payment_id);
    const afterDeny = await appGet("/v1/app/home");
    assert.equal(afterDeny.status, 200);
    assert.equal(
      afterDeny.data.agent_wallet.balance.amount,
      beforeDeny.data.agent_wallet.balance.amount,
      "Denied request moved wallet funds",
    );
    const unpaidOrder = await tool("get_order", {
      order_id: denyOrder.order_id,
    });
    assert.equal(unpaidOrder.status, "awaiting_payment");

    const feed = await json(
      config.gateway,
      `/v1/demo/console/events?after=${cursor}`,
    );
    assert.equal(feed.status, 200);
    const events = feed.data.events as Json[];
    function evidence(
      paymentId: string,
      result: "pass" | "deny",
      settlement: "paid" | "denied",
      approvalSource: "auto" | null,
    ) {
      const subject = consoleSubject(paymentId);
      const related = events.filter((event) => event.subject === subject);
      assert.ok(
        related.some(
          (event) =>
            event.kind === "guardian" &&
            event.result === result &&
            event.source === "Hermes",
        ),
        "Missing actual Hermes Guardian verdict",
      );
      assert.ok(
        related.some(
          (event) =>
            event.kind === "settlement" &&
            event.status === settlement &&
            event.approval_source === approvalSource,
        ),
        "Missing expected settlement evidence",
      );
    }
    evidence(auto.payment_id, "pass", "paid", "auto");
    evidence(denied.payment_id, "deny", "denied", null);
    console.log(
      "Live Hermes supplied both verdicts; bank console, shop, Gateway, wallet, and FISCO outcomes agree.",
    );
  } finally {
    await shopClient.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const config = acceptanceConfig(process.env, process.argv.slice(2));
  if (process.argv.includes("--check-config")) {
    console.log(
      `Configuration safe for ${config.ownerFinal ? "explicit owner final acceptance" : "isolated disposable acceptance"}.`,
    );
    console.log(
      "Execution would pair one agent, create three signed shop orders, approve one Amber payment, drop coffee to ¥72 through the operator route, switch that agent to Green, and submit two more payment requests.",
    );
  } else {
    run(config).catch((error) => {
      console.error(
        error instanceof Error ? error.message : "Acceptance failed",
      );
      process.exitCode = 1;
    });
  }
}
