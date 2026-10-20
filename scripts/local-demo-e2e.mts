import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { WeBankConnector } from "../agents/connector-mcp/src/client.js";
import type {
  CredentialStore,
  Credentials,
} from "../agents/connector-mcp/src/storage.js";
import { clientAppIdentity } from "../agents/connector-mcp/src/storage.js";
import {
  demoVariantBySku,
  ShopCheckoutRequestSchema,
} from "../packages/contracts/src/index.js";

const gateway = "http://127.0.0.1:3002";
const shop = "http://127.0.0.1:3001";
const loginToken = process.env.WEBANK_DEMO_LOGIN_TOKEN;
const mode = process.env.WEBANK_E2E_MODE ?? "success";
assert.ok(
  loginToken,
  "Set WEBANK_DEMO_LOGIN_TOKEN from the local Gateway console",
);
assert.ok(["success", "security-only", "callback-failure"].includes(mode));

let saved: Credentials | null = null;
const store: CredentialStore = {
  load: async () => saved,
  save: async (value) => {
    saved = value;
  },
};
const connector = new WeBankConnector(
  new URL(gateway),
  store,
  fetch,
  async () => {},
);
connector.bindClientApp(clientAppIdentity("WeBank local E2E"));

async function json(
  origin: string,
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
  cookie?: string,
) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...(method === "POST" && origin === gateway
        ? { "idempotency-key": randomUUID() }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
  });
  return { status: response.status, data: await response.json(), response };
}

async function appGet(path: string, cookie: string) {
  return json(gateway, path, "GET", undefined, cookie);
}

async function appPost(path: string, body: unknown, cookie: string) {
  return json(gateway, path, "POST", body, cookie);
}

async function shopPost(operation: string, body: Record<string, unknown> = {}) {
  const result = await json(shop, "/api/shop", "POST", { operation, ...body });
  assert.equal(
    result.status,
    200,
    `${operation}: ${JSON.stringify(result.data)}`,
  );
  return result.data as Record<string, unknown>;
}

async function shopOperatorPost(
  operation: string,
  body: Record<string, unknown> = {},
) {
  const token = readFileSync(
    new URL("./local-demo-runtime/shop-operator-token", import.meta.url),
    "utf8",
  ).trim();
  assert.ok(token, "Local shop operator token is empty");
  const response = await fetch(`${shop}/internal/demo-control`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ operation, ...body }),
    redirect: "error",
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return result as Record<string, unknown>;
}

async function resetShopAsOperator() {
  const result = await shopOperatorPost("reset");
  assert.deepEqual(result, {
    ok: true,
    reset: true,
    attack: false,
    coffee_price: 8800,
  });
}

async function checkout(sku: string) {
  const variant = demoVariantBySku(sku);
  assert.ok(variant, `Unknown demo variant: ${sku}`);
  await shopPost("add_to_cart", { sku, qty: 1, options: variant.options });
  const checkoutRequest = ShopCheckoutRequestSchema.parse({
    shipping_address: {
      name: "Lin Demo",
      phone: "13800138000",
      address_line: "88 Demo Road",
      city: "Shenzhen",
      postcode: "518000",
    },
  });
  return shopPost("checkout", checkoutRequest) as Promise<{
    order_id: string;
    payment_request: string;
  }>;
}

async function pendingCard(cookie: string, subjectId: string) {
  const approvals = await appGet("/v1/app/approvals?status=pending", cookie);
  assert.equal(approvals.status, 200);
  const matches = (
    approvals.data as {
      items: Array<{
        subject_id: string;
        approval_id: string;
        payload_hash: string;
      }>;
    }
  ).items.filter((item) => item.subject_id === subjectId);
  assert.equal(matches.length, 1, `Expected one pending card for ${subjectId}`);
  const card = matches[0];
  assert.ok(card, `Missing pending card for ${subjectId}`);
  return card;
}

async function approveCard(
  cookie: string,
  card: { approval_id: string; payload_hash: string },
  requestNumber?: string,
) {
  return appPost(
    `/v1/app/approvals/${card.approval_id}/decide`,
    {
      decision: "approve",
      verification: {
        action_hash: card.payload_hash,
        device_signature: "simulated-local-approval",
        ...(requestNumber ? { request_number: requestNumber } : {}),
      },
    },
    cookie,
  );
}

function mandateRequest(
  amount: number,
  categories: string[],
  description = "Local CLI checkout under the approved cap",
) {
  return {
    description,
    user_text: description,
    intent_level: "open",
    constraints: [
      { type: "amount_range", max: { amount, currency: "CNY" } },
      { type: "categories", allowed: categories },
      { type: "budget", max: { amount, currency: "CNY" } },
      { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
      {
        type: "execution_window",
        not_before: null,
        not_after: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
  };
}

async function mandate(cookie: string, amount: number, categories: string[]) {
  const proposed = await connector.createMandate(
    mandateRequest(amount, categories),
  );
  assert.equal(proposed.status, "pending_checkout");
  assert.equal(proposed.approval_timing, "payment");
  assert.equal("approval_id" in proposed, false);
  assert.equal("request_number" in proposed, false);
  const recorded = await connector.getMandateStatus(proposed.mandate_id);
  assert.equal(recorded.status, "pending_checkout");
  const approvals = await appGet("/v1/app/approvals?status=pending", cookie);
  assert.equal(approvals.status, 200);
  assert.equal(
    (approvals.data as { items: Array<{ subject_id: string }> }).items.some(
      (item) => item.subject_id === proposed.mandate_id,
    ),
    false,
  );
  return proposed.mandate_id;
}

async function main() {
  const loginResponse = await fetch(`${gateway}/demo/login`, {
    method: "POST",
    headers: { authorization: `Bearer ${loginToken}` },
  });
  assert.equal(loginResponse.status, 200);
  assert.equal(
    ((await loginResponse.json()) as { simulated: boolean }).simulated,
    true,
  );
  const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);

  if (mode === "success") {
    const stopPriorDrill = await appPost(
      "/v1/app/demo/drills/stop",
      {},
      cookie,
    );
    assert.equal(
      stopPriorDrill.status,
      200,
      JSON.stringify(stopPriorDrill.data),
    );
    await resetShopAsOperator();
  }
  const pairing = await connector.connect({
    client_name: "CLI demo connector",
  });
  assert.equal(pairing.status, "awaiting_user");
  assert.match(pairing.request_number, /^\d{6}$/);
  const pairCard = await appGet(`/v1/app/pairing/${pairing.user_code}`, cookie);
  assert.equal(pairCard.status, 200);
  const pairApproval = await appPost(
    `/v1/app/pairing/${pairing.user_code}/approve`,
    {
      verification: {
        action_hash: (pairCard.data as { approval: { payload_hash: string } })
          .approval.payload_hash,
        device_signature: "simulated-local-approval",
        request_number: pairing.request_number,
      },
    },
    cookie,
  );
  assert.equal(pairApproval.status, 200, JSON.stringify(pairApproval.data));
  const connected = await connector.connect();
  assert.equal(connected.status, "connected");
  console.log(
    "pairing: six-digit match and signed connector identity accepted",
  );

  if (mode !== "security-only") {
    const sku =
      mode === "callback-failure" ? "FIELD-COFFEE-1KG" : "NOVA-Q3-BLK";
    const category = mode === "callback-failure" ? "lifestyle" : "electronics";
    const amount = mode === "callback-failure" ? 10_000 : 30_000;
    const mandateId = await mandate(cookie, amount, [category]);
    console.log(
      "mandate: attended intent locked, no approval card or reservation",
    );
    const order = await checkout(sku);
    const payment = await connector.requestPayment({
      mandate_id: mandateId,
      payment_request: order.payment_request,
      price_evidence: [],
      rationale: "CLI demo selected the signed shop order",
    });
    assert.equal(payment.status, "awaiting_user", JSON.stringify(payment));
    if (
      !payment.payment_id ||
      !payment.approval_id ||
      !("request_number" in payment) ||
      typeof payment.request_number !== "string"
    )
      throw new Error("Expected a numbered pending payment, not a mandate");
    assert.match(payment.request_number, /^\d{6}$/);
    const paymentCard = await pendingCard(cookie, payment.payment_id);
    assert.equal(paymentCard.approval_id, payment.approval_id);
    const decided = await approveCard(
      cookie,
      paymentCard,
      payment.request_number,
    );
    const orderAfter = await json(
      shop,
      `/api/shop?operation=get_order&order_id=${order.order_id}`,
    );
    assert.equal(orderAfter.status, 200);
    if (mode === "callback-failure") {
      assert.equal(decided.status, 503);
      const reconciliation = decided.data as {
        error: { code: string; payment_tx: string };
      };
      assert.equal(reconciliation.error.code, "reconciliation_required");
      assert.match(reconciliation.error.payment_tx, /^0x[0-9a-f]{64}$/i);
      assert.equal(
        (orderAfter.data as { status: string }).status,
        "awaiting_payment",
      );
      const detail = await appGet(
        `/v1/app/payments/${payment.payment_id}`,
        cookie,
      );
      assert.equal(detail.status, 503);
      console.log(
        "callback failure: FISCO tx retained, app requires reconciliation, shop not falsely paid",
      );
      return;
    }
    assert.equal(decided.status, 200, JSON.stringify(decided.data));
    const detail = await appGet(
      `/v1/app/payments/${payment.payment_id}`,
      cookie,
    );
    assert.equal(detail.status, 200);
    const paymentDetail = detail.data as {
      status: string;
      receipt: { chain: { payment_tx: string; audit_tx: string } };
    };
    const receipt = paymentDetail.receipt;
    assert.equal(paymentDetail.status, "paid");
    assert.match(receipt.chain.payment_tx, /^0x[0-9a-f]{64}$/i);
    assert.match(receipt.chain.audit_tx, /^0x[0-9a-f]{64}$/i);
    const paidOrder = orderAfter.data as { status: string; payment_tx: string };
    assert.equal(paidOrder.status, "paid");
    assert.equal(paidOrder.payment_tx, receipt.chain.payment_tx);
    const connectorStatus = await connector.getPaymentStatus(
      payment.payment_id,
    );
    assert.equal(connectorStatus.status, "paid");
    console.log(
      `payment: paid, shop callback matched, tx=${receipt.chain.payment_tx}, audit=${receipt.chain.audit_tx}`,
    );
  }

  await shopOperatorPost("set_scenario", {
    scenario: "attack",
    enabled: true,
  });
  const attackMandate = await mandate(cookie, 20_000, ["electronics"]);
  const malicious = await checkout("FLASH-Q3-FEE");
  const encoded = malicious.payment_request.split("d=")[1];
  assert.ok(encoded);
  const tampered = JSON.parse(Buffer.from(encoded, "base64url").toString());
  tampered.amount.amount += 1;
  const tamperedUri = `ecny://pay?d=${Buffer.from(JSON.stringify(tampered)).toString("base64url")}`;
  await assert.rejects(
    () =>
      connector.requestPayment({
        mandate_id: attackMandate,
        payment_request: tamperedUri,
        price_evidence: [],
        rationale: "Tampered signed request",
      }),
    { code: "payreq_invalid" },
  );
  const maliciousOrder = await json(
    shop,
    `/api/shop?operation=get_order&order_id=${malicious.order_id}`,
  );
  assert.equal(
    (maliciousOrder.data as { status: string }).status,
    "awaiting_payment",
  );
  console.log("tampering: merchant signature rejected, no shop fulfillment");

  const decoyMandate = await mandate(cookie, 10_000, ["electronics"]);
  const prepareInactiveDecoy = await appPost(
    "/v1/app/demo/drills/start",
    {},
    cookie,
  );
  assert.equal(
    prepareInactiveDecoy.status,
    200,
    JSON.stringify(prepareInactiveDecoy.data),
  );
  const decoy = await checkout("REWARD-GIFT-500");
  const stopBeforeAttempt = await appPost(
    "/v1/app/demo/drills/stop",
    {},
    cookie,
  );
  assert.equal(
    stopBeforeAttempt.status,
    200,
    JSON.stringify(stopBeforeAttempt.data),
  );
  assert.equal((stopBeforeAttempt.data as { active: boolean }).active, false);
  const hidden = await json(
    shop,
    "/api/shop?operation=search_products&query=reward%20voucher",
  );
  assert.equal(hidden.status, 200);
  assert.deepEqual(hidden.data, []);
  const deniedDecoy = await connector.requestPayment({
    mandate_id: decoyMandate,
    payment_request: decoy.payment_request,
    price_evidence: [],
    rationale: "Fire drill decoy",
  });
  assert.equal(deniedDecoy.status, "denied");
  const beforeDrill = await appGet("/v1/app/agents", cookie);
  assert.equal(beforeDrill.status, 200);
  const beforeDrillAgent = (
    beforeDrill.data as {
      items: Array<{
        agent_id: string;
        licence: { level: string; drills_failed: number };
      }>;
    }
  ).items.find((item) => item.agent_id === connected.agent_id);
  assert.ok(beforeDrillAgent);
  assert.notEqual(beforeDrillAgent.licence.level, "RED");
  assert.equal(beforeDrillAgent.licence.drills_failed, 0);
  console.log("decoy without active bank drill: denied, no false Red light");

  const drillStart = await appPost("/v1/app/demo/drills/start", {}, cookie);
  assert.equal(drillStart.status, 200, JSON.stringify(drillStart.data));
  assert.equal((drillStart.data as { active: boolean }).active, true);
  const activeDrill = await appGet("/v1/app/demo/drills", cookie);
  assert.equal(activeDrill.status, 200);
  assert.equal((activeDrill.data as { active: boolean }).active, true);
  const visible = await json(
    shop,
    "/api/shop?operation=search_products&query=reward%20voucher",
  );
  assert.equal(visible.status, 200);
  assert.equal(
    (visible.data as Array<{ sku: string }>)[0]?.sku,
    "REWARD-GIFT-500",
  );
  const activeDrillMandate = await mandate(cookie, 10_000, ["electronics"]);
  const activeDecoy = await checkout("REWARD-GIFT-500");
  const drilled = await connector.requestPayment({
    mandate_id: activeDrillMandate,
    payment_request: activeDecoy.payment_request,
    price_evidence: [],
    rationale: "Active fire drill decoy",
  });
  assert.equal(drilled.status, "denied");
  const afterDrill = (await connector.getWalletStatus()) as {
    state: string;
    licence: { level: string; drills_failed: number };
  };
  assert.equal(afterDrill.state, "red");
  assert.equal(afterDrill.licence.level, "RED");
  assert.equal(afterDrill.licence.drills_failed, 1);
  const drillStop = await appPost("/v1/app/demo/drills/stop", {}, cookie);
  assert.equal(drillStop.status, 200, JSON.stringify(drillStop.data));
  assert.equal((drillStop.data as { active: boolean }).active, false);
  await shopOperatorPost("set_scenario", {
    scenario: "attack",
    enabled: false,
  });
  console.log(
    "active fire drill: decoy denied, agent Red, drill and attack display stopped",
  );

  const frozen = await appPost(
    `/v1/app/agents/${connected.agent_id}/freeze`,
    {},
    cookie,
  );
  assert.equal(frozen.status, 200);
  await assert.rejects(
    () =>
      connector.createMandate(
        mandateRequest(1000, ["electronics"], "Should be blocked after freeze"),
      ),
    { code: "agent_frozen" },
  );
  console.log("freeze: app froze agent, signed connector request rejected");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
