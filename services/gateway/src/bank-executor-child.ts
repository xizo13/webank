import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentWalletAbi, connectFisco, ECnySimAbi } from "@webank/chain";
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
  (kind !== "fund" && kind !== "sweep" && kind !== "human") ||
  !/^(fnd|swp|hpm)_[A-Za-z0-9_-]+$/.test(id ?? "") ||
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
const intent =
  kind === "fund"
    ? envelope.payload.fundingRecords?.find((item) => item.fundingId === id)
    : kind === "sweep"
      ? envelope.payload.sweepRecords?.find((item) => item.sweepId === id)
      : envelope.payload.humanPaymentRecords?.find(
          (item) => item.confirmationId === id,
        );
if (
  intent?.status !== "settling" ||
  intent.amount !== Number(amount) ||
  intent.deployment !== expectedDeployment
)
  throw new Error("No exact settling owner intent exists");
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
if (kind === "human") {
  if (!intent || !("merchantId" in intent) || !("payout" in intent))
    throw new Error("Human payment intent is invalid");
  const merchant = await chain.getMerchant(
    addresses.merchantRegistry,
    keccak256(stringToHex(intent.merchantId)),
  );
  if (
    !merchant.active ||
    getAddress(merchant.payout) !== getAddress(intent.payout) ||
    getAddress(intent.payout) === getAddress(addresses.agentWallet) ||
    getAddress(intent.payout) === getAddress(addresses.bank)
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
          (intent as { payout: `0x${string}` }).payout,
          amount,
        );
process.stdout.write(`${JSON.stringify({ tx_hash: tx })}\n`);
