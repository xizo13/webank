import {
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
} from "node:crypto";
import type { ChainAddresses, FiscoChain } from "@webank/chain";
import type { Policy } from "@webank/contracts";
import { createGuardianEvaluator } from "@webank/guardian";
import { createGateway } from "./app.js";
import { createFiscoGatewayAdapters } from "./fisco.js";
import { createShopPaymentNotifier } from "./shop-notifier.js";
import type { GatewayDependencies } from "./types.js";

type ManifestMerchant = {
  merchant_id: string;
  ed25519_public_key: string;
  legal_name: string;
  uscc: string;
  category: string;
  honeypot: boolean;
  active: boolean;
};

export type LocalDemoOptions = {
  chain: FiscoChain;
  addresses: ChainAddresses;
  merchants: ManifestMerchant[];
  shopOrigin: string;
  appOrigin: string;
  gatewayOrigin: string;
  shopToken: string;
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

function loopbackOrigin(value: string, name: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(`${name} must be an HTTP origin on 127.0.0.1`);
  return url.origin;
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Composes real Gateway checks and FISCO event verification with a clearly
 * simulated app approval and reservation ledger. Never use outside loopback.
 */
export async function createLocalDemoGateway(options: LocalDemoOptions) {
  const env = options.env ?? process.env;
  if (
    env.NODE_ENV === "production" ||
    env.WEBANK_LOCAL_DEMO !== "1" ||
    env.WEBANK_DEMO_APPROVALS !== "1"
  )
    throw new Error(
      "Local demo requires WEBANK_LOCAL_DEMO=1 and WEBANK_DEMO_APPROVALS=1 outside production",
    );
  const shopOrigin = loopbackOrigin(options.shopOrigin, "Shop origin");
  const appOrigin = loopbackOrigin(options.appOrigin, "App origin");
  const gatewayOrigin = loopbackOrigin(options.gatewayOrigin, "Gateway origin");
  if (!options.shopToken || /[\r\n]/.test(options.shopToken))
    throw new Error("SHOP_INTERNAL_TOKEN is required");
  if (!options.merchants.length)
    throw new Error("Bank-controlled merchant manifest is empty");
  const merchantById = new Map(
    options.merchants.map((entry) => [entry.merchant_id, entry]),
  );
  if (merchantById.size !== options.merchants.length)
    throw new Error("Duplicate bank-controlled merchant identity");
  const fetcher = options.fetcher ?? fetch;
  const shopResponse = await fetcher(`${shopOrigin}/api/merchants`, {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!shopResponse.ok) throw new Error("Local shop registry unavailable");
  const shopRegistry: unknown = await shopResponse.json();
  if (
    !shopRegistry ||
    typeof shopRegistry !== "object" ||
    !("simulated" in shopRegistry) ||
    shopRegistry.simulated !== true ||
    !("merchants" in shopRegistry) ||
    !Array.isArray(shopRegistry.merchants)
  )
    throw new Error("Local shop registry is invalid");
  const served = new Map<string, ManifestMerchant>();
  for (const raw of shopRegistry.merchants) {
    if (
      !raw ||
      typeof raw !== "object" ||
      !("merchant_id" in raw) ||
      typeof raw.merchant_id !== "string"
    )
      throw new Error("Local shop merchant identity is invalid");
    if (served.has(raw.merchant_id))
      throw new Error("Duplicate local shop merchant identity");
    served.set(raw.merchant_id, raw as ManifestMerchant);
  }
  if (served.size !== merchantById.size)
    throw new Error(
      "Local shop merchant registry does not match bank manifest",
    );
  const chainAdapter = createFiscoGatewayAdapters({
    chain: options.chain,
    addresses: options.addresses,
    classifyMerchant: async (id) => {
      const entry = merchantById.get(id);
      return entry
        ? {
            name: entry.legal_name,
            first_seen: false,
            honeypot: entry.honeypot,
          }
        : null;
    },
  });
  for (const entry of options.merchants) {
    const shopEntry = served.get(entry.merchant_id);
    const chainEntry = await chainAdapter.lookupMerchant(entry.merchant_id);
    if (
      !entry.active ||
      !shopEntry?.active ||
      shopEntry.ed25519_public_key !== entry.ed25519_public_key ||
      shopEntry.legal_name !== entry.legal_name ||
      shopEntry.uscc !== entry.uscc ||
      shopEntry.category !== entry.category ||
      shopEntry.honeypot !== entry.honeypot ||
      !chainEntry ||
      chainEntry.public_key !== entry.ed25519_public_key ||
      chainEntry.legal_name !== entry.legal_name ||
      chainEntry.uscc !== entry.uscc ||
      chainEntry.category !== entry.category
    )
      throw new Error(`Merchant identity mismatch: ${entry.merchant_id}`);
  }

  const userId = "usr_local_demo";
  const loginToken = randomBytes(24).toString("base64url");
  const sessionToken = randomBytes(24).toString("base64url");
  const receiptKey = generateKeyPairSync("ed25519");
  const reservations = new Map<string, number>();
  const policy: Policy = {
    schema: "policy.v1",
    user_id: userId,
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
  const deps: GatewayDependencies = {
    ...chainAdapter,
    authenticateApp: async (request) => {
      const cookie = request.headers.cookie?.match(
        /(?:^|;\s*)webank_local_demo_session=([^;]+)/,
      )?.[1];
      return cookie && equalSecret(cookie, sessionToken) ? userId : null;
    },
    demoApprovalsEnabled: true,
    demoApprovalVerifier: async (_approval, verification) => {
      const value = verification as { device_signature?: unknown };
      return value?.device_signature === "simulated-local-approval"
        ? "demo_simulation"
        : false;
    },
    recordNumberMatchFailure: async () => {},
    reserveMandate: async (mandate) => {
      const budget = mandate.constraints.find((item) => item.type === "budget");
      if (!budget || reservations.has(mandate.mandate_id)) return false;
      const used = [...reservations.values()].reduce(
        (total, amount) => total + amount,
        0,
      );
      if (used + budget.max.amount > 50_000) return false;
      reservations.set(mandate.mandate_id, budget.max.amount);
      return true;
    },
    releaseMandate: async (mandate) => {
      reservations.delete(mandate.mandate_id);
    },
    assessRisk: async () => ({
      result: "step_up",
      signals: [{ type: "local_demo", score: 1, action: "step_up" }],
      explanation: "Local demo risk fixture requires user review.",
    }),
    evaluateGuardian: createGuardianEvaluator({ apiKey: "" }),
    notifyMerchantPayment: createShopPaymentNotifier({
      shopOrigin,
      internalToken: options.shopToken,
      fetcher,
    }),
    signReceipt: async (bytes) =>
      sign(null, bytes, receiptKey.privateKey).toString("base64url"),
    appCorsOrigin: appOrigin,
    verificationUriBase: `${gatewayOrigin}/v1/app/pairing`,
  };
  const app = createGateway(deps, { agents: [], policies: [policy] });
  app.post("/demo/login", async (request, reply) => {
    const supplied =
      request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1] ??
      "";
    if (!equalSecret(supplied, loginToken))
      return reply.code(401).send({ error: "demo_login_denied" });
    return reply
      .header(
        "Set-Cookie",
        `webank_local_demo_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/`,
      )
      .send({ simulated: true, user_id: userId });
  });
  return { app, loginToken, receiptPublicKey: receiptKey.publicKey };
}
