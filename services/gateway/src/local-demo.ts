import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
} from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChainAddresses, FiscoChain } from "@webank/chain";
import type { Mandate, Policy } from "@webank/contracts";
import { createGuardianEvaluator } from "@webank/guardian";
import type { Address, Hex } from "viem";
import { createGateway } from "./app.js";
import { createLocalBankExecutor } from "./bank-executor.js";
import { DurableState } from "./durable-state.js";
import { createFiscoFundingRail, createFiscoGatewayAdapters } from "./fisco.js";
import { isActiveFundedDeployment } from "./funded-deployment.js";
import { assessLocalDemoRisk } from "./local-demo-risk.js";
import { createShopPaymentNotifier } from "./shop-notifier.js";
import { trustOrdinal } from "./trust-light.js";
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
  addresses: ChainAddresses & {
    bank?: Address;
    migration?: { state: string };
  };
  merchants: ManifestMerchant[];
  shopOrigin: string;
  appOrigin: string;
  gatewayOrigin: string;
  shopToken: string;
  fetcher?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  statePath?: string;
  bankExecutor?: {
    fund(fundingId: string, amount: bigint): Promise<Hex>;
    sweep(sweepId: string, amount: bigint): Promise<Hex>;
    payFromMain(confirmationId: string, amount: bigint): Promise<Hex>;
    setTrustLight?(intentId: string, level: 1 | 2 | 4): Promise<Hex>;
    setCaps?(changeId: string): Promise<Hex>;
  };
};

type DemoIdentity = {
  loginToken: string;
  sessionToken: string;
  receiptPrivateKey: string;
};

function demoIdentity(statePath?: string): DemoIdentity {
  if (!statePath) {
    return {
      loginToken: randomBytes(24).toString("base64url"),
      sessionToken: randomBytes(24).toString("base64url"),
      receiptPrivateKey: generateKeyPairSync("ed25519")
        .privateKey.export({ format: "pem", type: "pkcs8" })
        .toString(),
    };
  }
  const store = new DurableState<DemoIdentity>(`${statePath}.identity`);
  try {
    const existing = store.load();
    if (existing) {
      if (
        !/^[A-Za-z0-9_-]{32}$/.test(existing.loginToken) ||
        !/^[A-Za-z0-9_-]{32}$/.test(existing.sessionToken) ||
        typeof existing.receiptPrivateKey !== "string" ||
        !existing.receiptPrivateKey.includes("BEGIN PRIVATE KEY")
      )
        throw new Error("Local demo identity is incompatible");
      return existing;
    }
    const created = demoIdentity();
    store.save(created);
    return created;
  } finally {
    store.close();
  }
}

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
  if (
    options.statePath &&
    existsSync(options.statePath) !==
      existsSync(`${options.statePath}.identity`)
  )
    throw new Error(
      "Gateway state and local demo signing identity must both exist or both be new",
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
  const identity = demoIdentity(options.statePath);
  const { loginToken, sessionToken } = identity;
  const receiptKey = identity.receiptPrivateKey;
  const fundingEnabled = isActiveFundedDeployment(options.addresses);
  if (fundingEnabled && (!options.addresses.bank || !options.statePath))
    throw new Error(
      "Active funding deployment needs the bank address and durable Gateway state",
    );
  const bankExecutor =
    options.bankExecutor ??
    (fundingEnabled
      ? createLocalBankExecutor(options.statePath ?? "", options.addresses)
      : undefined);
  const walletFunding =
    fundingEnabled && options.addresses.bank && bankExecutor
      ? createFiscoFundingRail({
          chain: options.chain,
          addresses: { ...options.addresses, bank: options.addresses.bank },
          bankExecutor,
        })
      : undefined;
  const reservations = new Map<string, Mandate>();
  const remainingHold = (mandate: Mandate) => {
    if (mandate.status !== "active") return 0;
    const budget = mandate.constraints.find((item) => item.type === "budget");
    return budget ? Math.max(0, budget.max.amount - mandate.spent.amount) : 0;
  };
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
  const bankTrustWriter = bankExecutor?.setTrustLight;
  const bankPolicyWriter = bankExecutor?.setCaps;
  const deps: GatewayDependencies = {
    ...chainAdapter,
    policyCaps:
      fundingEnabled && bankPolicyWriter
        ? {
            read: () =>
              options.chain.getPolicyCapsSnapshot(
                options.addresses.agentWallet,
              ),
            write: bankPolicyWriter,
          }
        : undefined,
    demoTrustControlsEnabled: true,
    setTrustLight: bankTrustWriter
      ? async (_agent, level, intentId) =>
          bankTrustWriter(intentId, trustOrdinal(level))
      : undefined,
    setDrillVisibility: async (enabled) => {
      const response = await fetcher(
        `${shopOrigin}/internal/drill-visibility`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          headers: {
            authorization: `Bearer ${options.shopToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ enabled }),
        },
      );
      if (!response.ok) throw new Error("Shop drill visibility sync failed");
      const result = (await response.json()) as { drill_visible?: unknown };
      if (result.drill_visible !== enabled)
        throw new Error("Shop drill visibility mismatch");
    },
    walletFunding,
    initialWalletEnabled: !fundingEnabled,
    verifyWalletEnableProof: async (actionHash, verification) => {
      const value = verification as {
        action_hash?: unknown;
        device_signature?: unknown;
      };
      return (
        value?.action_hash === actionHash &&
        value.device_signature === "simulated-local-wallet-enable"
      );
    },
    verifyFundingProof: fundingEnabled
      ? async (actionHash, verification) => {
          const value = verification as {
            action_hash?: unknown;
            device_signature?: unknown;
          };
          return (
            value?.action_hash === actionHash &&
            value.device_signature === "simulated-local-funding"
          );
        }
      : undefined,
    verifyHumanPaymentProof: fundingEnabled
      ? async (actionHash, verification) => {
          const value = verification as {
            action_hash?: unknown;
            device_signature?: unknown;
          };
          return (
            value?.action_hash === actionHash &&
            value.device_signature === "simulated-local-human-payment"
          );
        }
      : undefined,
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
        (total, item) => total + remainingHold(item),
        0,
      );
      if (walletFunding) {
        const snapshot = await walletFunding.snapshot();
        if (
          snapshot.walletFrozen ||
          BigInt(used + budget.max.amount) > snapshot.walletBalance
        )
          return false;
      } else if (used + budget.max.amount > 50_000) return false;
      reservations.set(mandate.mandate_id, mandate);
      return true;
    },
    releaseMandate: async (mandate) => {
      reservations.delete(mandate.mandate_id);
    },
    restoreReservations: (mandates) => {
      reservations.clear();
      for (const mandate of mandates) {
        if (mandate.status !== "active") continue;
        if (remainingHold(mandate) > 0)
          reservations.set(mandate.mandate_id, mandate);
      }
    },
    assessRisk: async (input) => assessLocalDemoRisk(input),
    evaluateGuardian: createGuardianEvaluator({
      baseUrl: env.WEBANK_GUARDIAN_HERMES_URL ?? "",
      apiKey: env.WEBANK_GUARDIAN_HERMES_KEY ?? "",
      model: env.WEBANK_GUARDIAN_HERMES_MODEL,
      operatorVerified: env.WEBANK_GUARDIAN_HERMES_PROFILE_VERIFIED === "1",
      fetcher,
    }),
    guardianSource: "Hermes",
    getPaymentBlock: async (paymentTx) => {
      const evidence = await options.chain.getTransactionEvidence(paymentTx);
      if (evidence.status !== "success")
        throw new Error("Payment transaction has no successful chain receipt");
      return evidence.blockNumber;
    },
    bankConsoleEnabled: true,
    consoleSimulationPath: fileURLToPath(
      new URL(
        "../../../scripts/local-demo-runtime/console-simulation.jsonl",
        import.meta.url,
      ),
    ),
    notifyMerchantPayment: createShopPaymentNotifier({
      shopOrigin,
      internalToken: options.shopToken,
      fetcher,
    }),
    signReceipt: async (bytes) =>
      sign(null, bytes, receiptKey).toString("base64url"),
    appCorsOrigin: appOrigin,
    verificationUriBase: `${gatewayOrigin}/v1/app/pairing`,
    statePath: options.statePath,
    stateContext: JSON.stringify(options.addresses),
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
  return {
    app,
    loginToken,
    receiptPublicKey: createPublicKey(createPrivateKey(receiptKey)),
  };
}
