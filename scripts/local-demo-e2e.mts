import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { WeBankConnector } from "../agents/connector-mcp/src/client.js";
import type {
  CredentialStore,
  Credentials,
} from "../agents/connector-mcp/src/storage.js";
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
  const card = (
    approvals.data as {
      items: Array<{
        subject_id: string;
        approval_id: string;
        payload_hash: string;
      }>;
    }
  ).items.find((item) => item.subject_id === subjectId);
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

async function mandate(cookie: string, amount: number, categories: string[]) {
  const proposed = await connector.createMandate({
    description: "Local CLI checkout under the approved cap",
    user_text: "Local CLI checkout under the approved cap",
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
  });
  assert.equal(proposed.status, "pending_user");
  const card = await pendingCard(cookie, proposed.mandate_id);
  const approved = await approveCard(cookie, card, proposed.request_number);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(
    (approved.data as { mandate: { approved_by: string } }).mandate.approved_by,
    "demo_simulation",
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

  if (mode === "success") await shopPost("reset");
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
    console.log("mandate: app simulation approved, budget reserved");
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
      !("request_number" in payment) ||
      typeof payment.request_number !== "string"
    )
      throw new Error("Expected a numbered pending payment, not a mandate");
    assert.match(payment.request_number, /^\d{6}$/);
    const paymentCard = await pendingCard(cookie, payment.payment_id);
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
  const decoy = await checkout("REWARD-GIFT-500");
  const deniedDecoy = await connector.requestPayment({
    mandate_id: decoyMandate,
    payment_request: decoy.payment_request,
    price_evidence: [],
    rationale: "Fire drill decoy",
  });
  assert.equal(deniedDecoy.status, "denied");
  console.log("decoy: signed honeypot request denied");

  const frozen = await appPost(
    `/v1/app/agents/${connected.agent_id}/freeze`,
    {},
    cookie,
  );
  assert.equal(frozen.status, 200);
  await assert.rejects(
    () =>
      connector.createMandate({
        description: "Should be blocked after freeze",
        user_text: "Should be blocked after freeze",
        intent_level: "open",
        constraints: [
          { type: "budget", max: { amount: 1000, currency: "CNY" } },
          { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
        ],
      }),
    { code: "agent_frozen" },
  );
  console.log("freeze: app froze agent, signed connector request rejected");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
