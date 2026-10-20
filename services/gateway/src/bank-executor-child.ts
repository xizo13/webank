import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentWalletAbi,
  AuditAnchorAbi,
  connectFisco,
  ECnySimAbi,
} from "@webank/chain";
import {
  createPublicClient,
  defineChain,
  getAddress,
  type Hex,
  http,
  keccak256,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  applyAuditedPolicyCaps,
  assertAuditedPolicyIntent,
} from "./bank-policy-intent.js";
import { trustOrdinal } from "./trust-light.js";

const expectedState = fileURLToPath(
  new URL(
    "../../../scripts/local-demo-runtime/gateway-state.json",
    import.meta.url,
  ),
);
const addressesPath = fileURLToPath(
  new URL("../../../scripts/chain/addresses.json", import.meta.url),
);
const bankKeyPath = fileURLToPath(
  new URL("../../../scripts/chain/runtime/bank.env", import.meta.url),
);
const args = process.argv.slice(2);
if (args.length !== 4) throw new Error("Bank executor request is invalid");
const [kind, id, rawAmount, statePath] = args as [
  string,
  string,
  string,
  string,
];
if (
  (kind !== "fund" &&
    kind !== "sweep" &&
    kind !== "human" &&
    kind !== "trust" &&
    kind !== "policy") ||
  !/^(fnd|swp|hpm|tev|pch)_[A-Za-z0-9_-]+$/.test(id ?? "") ||
  !/^[1-9][0-9]*$/.test(rawAmount ?? "") ||
  resolve(statePath ?? "") !== expectedState ||
  realpathSync(statePath) !== expectedState
)
  throw new Error("Bank executor request is invalid");
const amount = BigInt(rawAmount);
if (amount > BigInt(Number.MAX_SAFE_INTEGER))
  throw new Error("Amount is out of range");

for (const path of [statePath, addressesPath, bankKeyPath]) {
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error("Bank executor input permissions are unsafe");
}
const addresses = JSON.parse(readFileSync(addressesPath, "utf8")) as {
  chainId: number;
  rpcUrl: string;
  bank: `0x${string}`;
  gateway: `0x${string}`;
  ecnySim: `0x${string}`;
  agentWallet: `0x${string}`;
  merchantRegistry: `0x${string}`;
  licenceRegistry: `0x${string}`;
  auditAnchor: `0x${string}`;
  migration?: { state: string };
};
if (
  addresses.chainId !== 20200 ||
  addresses.rpcUrl !== "http://127.0.0.1:8545" ||
  addresses.migration?.state !== "active"
)
  throw new Error("Funding deployment is not active");
const expectedDeployment = JSON.stringify({
  token: addresses.ecnySim,
  main: addresses.bank,
  wallet: addresses.agentWallet,
});
const envelope = JSON.parse(readFileSync(statePath, "utf8")) as {
  version: number;
  payload: {
    context: string;
    fundingRecords?: Array<{
      fundingId: string;
      amount: number;
      status: string;
      deployment: string;
    }>;
    sweepRecords?: Array<{
      sweepId: string;
      amount: number;
      status: string;
      deployment: string;
    }>;
    humanPaymentRecords?: Array<{
      confirmationId: string;
      merchantId: string;
      payout: `0x${string}`;
      amount: number;
      status: string;
      deployment: string;
    }>;
    trustPending?: Array<{
      intentId: string;
      agentId: string;
      level: "AMBER" | "GREEN" | "RED";
      from: "AMBER" | "GREEN" | "RED";
      forceChain?: boolean;
      status: string;
      auditHash?: string;
    }>;
    policyChanges?: Array<{
      changeId: string;
      userId: string;
      status: string;
      auditHash?: string;
      baseCaps: { perPayment: number; daily: number; monthly: number };
      proposed: {
        per_payment_max: { amount: number; currency: string };
        daily_max: { amount: number; currency: string };
        monthly_max: { amount: number; currency: string };
      };
      deployment: string;
    }>;
    agents?: Array<{ agent_id: string; public_key: string }>;
    audits?: Array<{
      record_hash: string;
      subject_id: string;
      actor?: string;
      kind: string;
    }>;
    pairings?: Array<{ status: string; agentId?: string }>;
  };
  sha256: string;
};
const checksum = createHash("sha256")
  .update(JSON.stringify(envelope.payload))
  .digest("hex");
if (
  envelope.version !== 1 ||
  checksum !== envelope.sha256 ||
  envelope.payload.context !== JSON.stringify(addresses)
)
  throw new Error(
    "Gateway funding intent is not bound to the active deployment",
  );
const transferIntent =
  kind === "fund"
    ? envelope.payload.fundingRecords?.find((item) => item.fundingId === id)
    : kind === "sweep"
      ? envelope.payload.sweepRecords?.find((item) => item.sweepId === id)
      : kind === "human"
        ? envelope.payload.humanPaymentRecords?.find(
            (item) => item.confirmationId === id,
          )
        : undefined;
const trustIntent =
  kind === "trust"
    ? envelope.payload.trustPending?.find((item) => item.intentId === id)
    : undefined;
const policyIntent =
  kind === "policy"
    ? envelope.payload.policyChanges?.find((item) => item.changeId === id)
    : undefined;
if (
  kind !== "trust" &&
  kind !== "policy" &&
  (transferIntent?.status !== "settling" ||
    transferIntent.amount !== Number(amount) ||
    transferIntent.deployment !== expectedDeployment)
)
  throw new Error("No exact settling owner intent exists");
if (
  kind === "trust" &&
  (trustIntent?.status !== "anchored" ||
    trustOrdinal(trustIntent.level) !== Number(amount) ||
    ![1, 2, 4].includes(Number(amount)) ||
    typeof trustIntent.auditHash !== "string" ||
    !envelope.payload.agents?.some(
      (agent) => agent.agent_id === trustIntent.agentId,
    ))
)
  throw new Error("No exact audited trust intent exists");
if (kind === "policy") {
  assertAuditedPolicyIntent(
    policyIntent,
    envelope.payload.audits,
    expectedDeployment,
    amount,
  );
}
const keyText = readFileSync(bankKeyPath, "utf8");
const match = /^FISCO_BANK_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\n?$/.exec(keyText);
if (!match) throw new Error("Bank key file is invalid");
const privateKey = match[1] as Hex;
if (
  privateKeyToAccount(privateKey).address.toLowerCase() !==
  addresses.bank.toLowerCase()
)
  throw new Error("Bank signer does not match the active deployment");
const client = createPublicClient({
  chain: defineChain({
    id: 20200,
    name: "FISCO BCOS local 20200",
    nativeCurrency: { name: "FISCO balance", symbol: "FISCO", decimals: 18 },
    rpcUrls: { default: { http: [addresses.rpcUrl] } },
  }),
  transport: http(addresses.rpcUrl),
});
const [configuredWallet, walletToken, walletBank] = await Promise.all([
  client.readContract({
    address: addresses.ecnySim,
    abi: ECnySimAbi,
    functionName: "agentWallet",
  }),
  client.readContract({
    address: addresses.agentWallet,
    abi: AgentWalletAbi,
    functionName: "token",
  }),
  client.readContract({
    address: addresses.agentWallet,
    abi: AgentWalletAbi,
    functionName: "bank",
  }),
]);
if (
  configuredWallet.toLowerCase() !== addresses.agentWallet.toLowerCase() ||
  walletToken.toLowerCase() !== addresses.ecnySim.toLowerCase() ||
  walletBank.toLowerCase() !== addresses.bank.toLowerCase()
)
  throw new Error("Token and wallet are not configured together");
const chain = await connectFisco({ rpcUrl: addresses.rpcUrl, privateKey });
if (kind === "policy") {
  if (!policyIntent?.auditHash) throw new Error("Policy audit missing");
  const anchored = await client.readContract({
    address: addresses.auditAnchor,
    abi: AuditAnchorAbi,
    functionName: "anchored",
    args: [`0x${policyIntent.auditHash.slice(7)}` as Hex],
  });
  if (!anchored) throw new Error("Policy audit not anchored");
  const tx = await applyAuditedPolicyCaps(
    chain,
    addresses.agentWallet,
    policyIntent,
  );
  process.stdout.write(`${JSON.stringify({ tx_hash: tx })}\n`);
  process.exit(0);
}
if (kind === "trust") {
  if (!trustIntent) throw new Error("Trust intent missing");
  const agent = envelope.payload.agents?.find(
    (item) => item.agent_id === trustIntent.agentId,
  );
  if (!agent) throw new Error("Trust intent agent is missing");
  if (
    !envelope.payload.audits?.some(
      (audit) =>
        audit.record_hash === trustIntent.auditHash &&
        audit.subject_id === agent.agent_id &&
        (audit.kind === "licence_change" || audit.kind === "drill"),
    )
  )
    throw new Error("Trust intent has no matching audit record");
  const anchored = await client.readContract({
    address: addresses.auditAnchor,
    abi: AuditAnchorAbi,
    functionName: "anchored",
    args: [`0x${trustIntent.auditHash?.slice(7)}` as Hex],
  });
  if (!anchored) throw new Error("Trust intent audit hash is not anchored");
  const agentHash = keccak256(stringToHex(agent.agent_id));
  const keyHash = keccak256(stringToHex(agent.public_key));
  const ordinal = trustOrdinal(trustIntent.level);
  if (
    trustIntent.forceChain &&
    (trustIntent.level !== "AMBER" ||
      trustIntent.from !== "AMBER" ||
      !envelope.payload.pairings?.some(
        (pairing) =>
          pairing.status === "processing" && pairing.agentId === agent.agent_id,
      ))
  )
    throw new Error("Initial Amber registry intent is not paired");
  const prior = await chain.getLicence(addresses.licenceRegistry, agentHash);
  const expectedPrior = trustOrdinal(trustIntent.from);
  const allowedPrior =
    (trustIntent.forceChain && prior.level === 0) ||
    prior.level === expectedPrior ||
    prior.level === ordinal ||
    (expectedPrior === 2 && prior.level === 3);
  if (!allowedPrior || (prior.level !== 0 && prior.keyHash !== keyHash))
    throw new Error("Trust registry prior light or key changed");
  const tx = await chain.setLicence(
    addresses.licenceRegistry,
    agentHash,
    keyHash,
    ordinal,
  );
  const verified = await chain.getLicence(addresses.licenceRegistry, agentHash);
  if (verified.level !== ordinal || verified.keyHash !== keyHash)
    throw new Error("Trust registry confirmation mismatch");
  process.stdout.write(`${JSON.stringify({ tx_hash: tx })}\n`);
  process.exit(0);
}
if (kind === "human") {
  if (
    !transferIntent ||
    !("merchantId" in transferIntent) ||
    !("payout" in transferIntent)
  )
    throw new Error("Human payment intent is invalid");
  const merchant = await chain.getMerchant(
    addresses.merchantRegistry,
    keccak256(stringToHex(transferIntent.merchantId)),
  );
  if (
    !merchant.active ||
    getAddress(merchant.payout) !== getAddress(transferIntent.payout) ||
    getAddress(transferIntent.payout) === getAddress(addresses.agentWallet) ||
    getAddress(transferIntent.payout) === getAddress(addresses.bank)
  )
    throw new Error("Human payment merchant payout changed");
}
const hashId = keccak256(stringToHex(id));
const tx =
  kind === "fund"
    ? await chain.fundAgentWallet(addresses.ecnySim, hashId, amount)
    : kind === "sweep"
      ? await chain.sweepToMain(addresses.agentWallet, hashId, amount)
      : await chain.transferMain(
          addresses.ecnySim,
          (transferIntent as { payout: `0x${string}` }).payout,
          amount,
        );
process.stdout.write(`${JSON.stringify({ tx_hash: tx })}\n`);
