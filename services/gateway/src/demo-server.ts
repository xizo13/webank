import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
} from "node:crypto";
import {
  type Agent,
  encodePaymentRequestUri,
  type Mandate,
  type Policy,
} from "@webank/contracts";
import { createGuardianEvaluator } from "@webank/guardian";
import { createGateway } from "./app.js";
import { canonicalJson } from "./crypto.js";
import {
  requiredLoginTokenPath,
  writePrivateLoginToken,
} from "./private-login-token.js";
import type { GatewayDependencies, Merchant } from "./types.js";

if (
  process.env.WEBANK_DEMO_SERVER !== "1" ||
  process.env.NODE_ENV === "production"
)
  throw new Error(
    "The mocked Gateway listener requires WEBANK_DEMO_SERVER=1 outside production",
  );

const host = "127.0.0.1";
const port = Number(process.env.WEBANK_DEMO_PORT ?? "3002");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid demo port");
const tokenFile = requiredLoginTokenPath("WEBANK_DEMO_TOKEN_FILE");
const loginToken = randomBytes(24).toString("base64url");
const sessionToken = randomBytes(24).toString("base64url");
const merchantKeys = generateKeyPairSync("ed25519");
const receiptKeys = generateKeyPairSync("ed25519");
const pairingKeys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const now = new Date();

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const merchant: Merchant = {
  merchant_id: "mch_demo",
  name: "Gateway Mock Shop",
  legal_name: "Gateway Mock Shop Ltd. (simulation)",
  uscc: "MOCK-GATEWAY-0001",
  category: "electronics",
  first_seen: false,
  honeypot: false,
  public_key: `0x${merchantKeys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`,
};
const agent: Agent = {
  schema: "agent.v1",
  agent_id: "agt_demo",
  user_id: "usr_demo",
  display_name: "Demo assistant",
  provider: "mock",
  public_key: "p256:demo-agent-key",
  scopes: ["wallet:pay", "wallet:mandate", "wallet:history:self"],
  licence: {
    level: "AMBER",
    clean_purchases: 0,
    drills_passed: 0,
    drills_failed: 0,
    flags_30d: 0,
    reason: "New agent, no history yet",
    updated_at: new Date().toISOString(),
  },
  status: "active",
  created_at: now.toISOString(),
  last_used_at: null,
};
const policy: Policy = {
  schema: "policy.v1",
  user_id: agent.user_id,
  per_payment_max: { amount: 30_000, currency: "CNY" },
  daily_max: { amount: 50_000, currency: "CNY" },
  monthly_max: { amount: 100_000, currency: "CNY" },
  auto_approve_below: { amount: 10_000, currency: "CNY" },
  blocked_categories: ["gift_cards"],
  new_merchant_requires_tap: false,
  treasurer: {
    enabled: false,
    buffer_target: { amount: 0, currency: "CNY" },
    daily_topup_ceiling: { amount: 10_000, currency: "CNY" },
    monthly_topup_ceiling: { amount: 20_000, currency: "CNY" },
    protected_main_balance: { amount: 30_000, currency: "CNY" },
  },
};
const mandate: Mandate = {
  schema: "mandate.v1",
  mandate_id: "mdt_demo",
  agent_id: agent.agent_id,
  agent_key_binding: agent.public_key,
  description: "Mock headphone purchase for app browser test",
  intent_level: "open",
  user_text: "Mock headphone purchase for app browser test",
  user_text_source: "webank_screen",
  constraints: [
    { type: "amount_range", max: { amount: 30_000, currency: "CNY" } },
    { type: "categories", allowed: ["electronics"] },
    { type: "budget", max: { amount: 30_000, currency: "CNY" } },
    { type: "recurrence", frequency: "NONE", max_occurrences: 1 },
    {
      type: "execution_window",
      not_before: null,
      not_after: new Date(now.getTime() + 86_400_000).toISOString(),
    },
  ],
  status: "active",
  spent: { amount: 0, currency: "CNY" },
  occurrences: 0,
  in_flight_payment_id: null,
  approved_by: "user_biometric",
  created_at: now.toISOString(),
};

const deps: GatewayDependencies = {
  authenticateAgent: async (request) =>
    request.headers.authorization === "Bearer demo-agent" ? agent : null,
  authenticateApp: async (request) => {
    const cookie = request.headers.cookie?.match(
      /(?:^|;\s*)webank_demo_session=([^;]+)/,
    )?.[1];
    return cookie && safeEqual(cookie, sessionToken) ? agent.user_id : null;
  },
  recordNumberMatchFailure: async () => {},
  lookupMerchant: async (id) => (id === merchant.merchant_id ? merchant : null),
  lookupVariant: async (sku) =>
    sku === "HEADPHONES-DEMO"
      ? {
          sku,
          gtin: "6901234567001",
          merchant_id: merchant.merchant_id,
          brand: "Nova",
          model: "Quiet 3",
          variant: "Black",
          options: { colour: "Black", size: "One size" },
        }
      : null,
  reserveMandate: async () => true,
  releaseMandate: async () => {},
  assessRisk: async () => ({
    result: "pass",
    signals: [],
    explanation: "Mock risk pass",
  }),
  evaluateGuardian: createGuardianEvaluator({
    baseUrl: process.env.WEBANK_GUARDIAN_HERMES_URL ?? "",
    apiKey: process.env.WEBANK_GUARDIAN_HERMES_KEY ?? "",
    model: process.env.WEBANK_GUARDIAN_HERMES_MODEL,
    operatorVerified:
      process.env.WEBANK_GUARDIAN_HERMES_PROFILE_VERIFIED === "1",
  }),
  executePayment: async () => {
    throw new Error("Mock demo listener cannot pay");
  },
  anchorAudit: async (hash) =>
    `0x${createHash("sha256").update(hash).digest("hex")}`,
  signReceipt: async (bytes) =>
    sign(null, bytes, receiptKeys.privateKey).toString("base64url"),
  appCorsOrigin: process.env.WEBANK_DEMO_APP_ORIGIN ?? "http://127.0.0.1:8081",
  verificationUriBase: `http://${host}:${port}/v1/app/pairing`,
};

const app = createGateway(deps, {
  agents: [agent],
  policies: [policy],
  mandates: [mandate],
});
app.post("/demo/login", async (request, reply) => {
  const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
  if (!safeEqual(supplied, loginToken))
    return reply.code(401).send({ error: "demo_login_denied" });
  return reply
    .header(
      "Set-Cookie",
      `webank_demo_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/`,
    )
    .send({ simulated: true, user_id: agent.user_id });
});

const unsigned = {
  schema: "payreq.v1" as const,
  merchant_id: merchant.merchant_id,
  order_id: `ord_demo_${randomUUID().replaceAll("-", "")}`,
  amount: { amount: 27_900, currency: "CNY" as const },
  line_items: [
    {
      type: "product" as const,
      sku: "HEADPHONES-DEMO",
      gtin: "6901234567001",
      name: "Mock headphones",
      condition: "new" as const,
      variant: "Black",
      options: { colour: "Black", size: "One size" },
      qty: 1,
      unit_price: { amount: 27_900, currency: "CNY" as const },
    },
    {
      type: "shipping" as const,
      name: "Standard delivery",
      qty: 1 as const,
      unit_price: { amount: 0, currency: "CNY" as const },
    },
  ],
  expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
  nonce: randomUUID(),
};
const uri = encodePaymentRequestUri({
  ...unsigned,
  merchant_sig: sign(
    null,
    Buffer.from(canonicalJson(unsigned)),
    merchantKeys.privateKey,
  ).toString("base64url"),
});
const pending = await app.inject({
  method: "POST",
  url: "/v1/agent/payments",
  headers: {
    authorization: "Bearer demo-agent",
    "idempotency-key": randomUUID(),
  },
  payload: {
    mandate_id: mandate.mandate_id,
    payment_request: uri,
    price_evidence: [],
    rationale: "Mock app test",
  },
});
if (pending.statusCode !== 202)
  throw new Error(`Failed to seed demo approval: ${pending.statusCode}`);

const pairing = await app.inject({
  method: "POST",
  url: "/v1/oauth/device_authorization",
  payload: {
    client_name: "Demo connector",
    provider: "mock",
    client_app_id: `app_${createHash("sha256").update("Mock app", "utf8").digest("hex")}`,
    client_app_name: "Mock app",
    agent_public_key: `p256:${pairingKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url")}`,
    requested_scopes: ["wallet:pay", "wallet:mandate", "wallet:history:self"],
  },
});
if (pairing.statusCode !== 200)
  throw new Error(`Failed to seed demo pairing: ${pairing.statusCode}`);

await writePrivateLoginToken(tokenFile, loginToken);
await app.listen({ host, port });
process.stdout.write(`Mock Gateway listening at http://${host}:${port}\n`);
process.stdout.write("Private demo login token file created.\n");
process.stdout.write(`Demo pairing code: ${pairing.json().user_code}\n`);
process.stdout.write(
  "All external services and starting records are simulated; approval is disabled.\n",
);
