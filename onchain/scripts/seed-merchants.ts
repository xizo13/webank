import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type MerchantRecord, MerchantRegistryAbi } from "@webank/chain";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hex,
  http,
  isAddress,
  keccak256,
  stringToHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

type MerchantSeed = {
  merchant_id: string;
  payout: Address;
  ed25519_public_key: Hex;
  legal_name: string;
  uscc: string;
  category: string;
  active: boolean;
};

function readSeeds(path: string): MerchantSeed[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && "merchants" in parsed
      ? parsed.merchants
      : undefined;
  assert.ok(
    Array.isArray(raw) && raw.length > 0,
    "Expected a nonempty merchants array",
  );
  const seen = new Set<string>();
  return raw.map((entry: unknown) => {
    assert.ok(entry && typeof entry === "object", "Expected merchant object");
    const merchant = entry as Partial<MerchantSeed>;
    const merchantId = merchant.merchant_id;
    assert.ok(typeof merchantId === "string", "Missing merchant ID");
    assert.match(merchantId, /^mch_[a-zA-Z0-9_]+$/);
    assert.ok(!seen.has(merchantId), "Duplicate merchant ID");
    seen.add(merchantId);
    assert.ok(
      isAddress(merchant.payout ?? ""),
      "Invalid merchant payout address",
    );
    assert.match(
      merchant.ed25519_public_key ?? "",
      /^0x[0-9a-fA-F]{64}$/,
      "Expected raw 32-byte Ed25519 key",
    );
    assert.ok(
      typeof merchant.legal_name === "string" && merchant.legal_name.length > 0,
      "Missing legal name",
    );
    assert.ok(
      typeof merchant.uscc === "string" && merchant.uscc.length > 0,
      "Missing mock USCC",
    );
    assert.ok(
      typeof merchant.category === "string" && merchant.category.length > 0,
      "Missing category",
    );
    assert.equal(typeof merchant.active, "boolean", "Missing active flag");
    return merchant as MerchantSeed;
  });
}

const bankPrivateKey = process.env.FISCO_BANK_PRIVATE_KEY;
const registryAddress = process.env.FISCO_MERCHANT_REGISTRY_ADDRESS;
const seedPath = process.env.FISCO_MERCHANTS_FILE;
if (!bankPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(bankPrivateKey)) {
  throw new Error("Set FISCO_BANK_PRIVATE_KEY to the local bank signer");
}
if (!registryAddress || !isAddress(registryAddress)) {
  throw new Error("Set FISCO_MERCHANT_REGISTRY_ADDRESS from deployment output");
}
if (!seedPath)
  throw new Error("Set FISCO_MERCHANTS_FILE to a merchant seed JSON path");

const seeds = readSeeds(seedPath);
const rpcUrl = process.env.FISCO_RPC_URL ?? "http://127.0.0.1:8545";
const chain = defineChain({
  id: 20200,
  name: "FISCO BCOS local 20200",
  nativeCurrency: { name: "FISCO balance", symbol: "FISCO", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const account = privateKeyToAccount(bankPrivateKey as Hex);
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
assert.equal(await publicClient.getChainId(), 20200, "Wrong Web3 RPC chain ID");
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

const results = [];
for (const merchant of seeds) {
  const merchantId = keccak256(stringToHex(merchant.merchant_id));
  const args = [
    merchantId,
    merchant.payout,
    merchant.ed25519_public_key,
    merchant.legal_name,
    merchant.uscc,
    merchant.category,
    merchant.active,
  ] as const;
  const { request } = await publicClient.simulateContract({
    address: registryAddress,
    abi: MerchantRegistryAbi,
    functionName: "setMerchant",
    args,
    account,
  });
  const txHash = await wallet.writeContract({ ...request, account, chain });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  });
  assert.equal(
    receipt.status,
    "success",
    `${merchant.merchant_id} registry transaction reverted`,
  );
  const record: MerchantRecord = await publicClient.readContract({
    address: registryAddress,
    abi: MerchantRegistryAbi,
    functionName: "getMerchant",
    args: [merchantId],
  });
  assert.equal(
    record.signingKey.toLowerCase(),
    merchant.ed25519_public_key.toLowerCase(),
  );
  assert.equal(record.payout.toLowerCase(), merchant.payout.toLowerCase());
  results.push({ merchant_id: merchant.merchant_id, merchantId, txHash });
}

process.stdout.write(
  `${JSON.stringify({ chainId: 20200, registryAddress, merchants: results }, null, 2)}\n`,
);
