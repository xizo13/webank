import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuditAnchorAbi,
  LicenceRegistryAbi,
  MerchantRegistryAbi,
} from "@webank/chain";
import {
  type Abi,
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hex,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export type Deployment = {
  chainId: 20200;
  rpcUrl: string;
  bank: Address;
  gateway: Address;
  ecnySim: Address;
  merchantRegistry: Address;
  licenceRegistry: Address;
  auditAnchor: Address;
  agentWallet: Address;
  txHashes: Record<string, Hex>;
};

export type SeedMerchant = {
  id: Hex;
  payout: Address;
  signingKey: Hex;
  legalName: string;
  uscc: string;
  category: string;
};

export type DeployOptions = {
  bankPrivateKey: Hex;
  gateway: Address;
  rpcUrl?: string;
  perPaymentCap?: bigint;
  dailyCap?: bigint;
  monthlyCap?: bigint;
  mainOpeningBalance?: bigint;
  reuse?: Pick<
    Deployment,
    "merchantRegistry" | "licenceRegistry" | "auditAnchor"
  >;
  merchant?: SeedMerchant;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = resolve(root, "artifacts", `${name}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  assert.match(parsed.compiler, /^0\.8\.11\+/, `${name} requires solc 0.8.11`);
  assert.equal(parsed.evmVersion, "london");
  return { abi: parsed.abi, bytecode: parsed.bytecode };
}

export async function deployAll(options: DeployOptions): Promise<Deployment> {
  const rpcUrl = options.rpcUrl ?? "http://127.0.0.1:8545";
  const bank = privateKeyToAccount(options.bankPrivateKey);
  assert.notEqual(
    options.gateway.toLowerCase(),
    bank.address.toLowerCase(),
    "Keep bank and gateway keys separate",
  );
  const chain = defineChain({
    id: 20200,
    name: "FISCO BCOS local 20200",
    nativeCurrency: { name: "FISCO balance", symbol: "FISCO", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  assert.equal(
    await publicClient.getChainId(),
    20200,
    "Wrong Web3 RPC chain ID",
  );
  const wallet = createWalletClient({
    account: bank,
    chain,
    transport: http(rpcUrl),
  });
  const txHashes: Record<string, Hex> = {};

  async function deploy(
    name: string,
    args: readonly unknown[] = [],
  ): Promise<Address> {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet.deployContract({
      abi,
      bytecode,
      args,
      account: bank,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", `${name} deployment reverted`);
    assert.ok(receipt.contractAddress, `${name} deployment omitted address`);
    txHashes[`deploy${name}`] = hash;
    return receipt.contractAddress;
  }

  async function write(
    name: string,
    address: Address,
    functionName: string,
    args: readonly unknown[],
    label: string,
  ) {
    const { abi } = artifact(name);
    const { request } = await publicClient.simulateContract({
      address,
      abi,
      functionName,
      args,
      account: bank,
    });
    const hash = await wallet.writeContract({
      ...request,
      account: bank,
      chain,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", `${label} reverted`);
    txHashes[label] = hash;
  }

  const ecnySim = await deploy("ECnySim");
  const merchantRegistry =
    options.reuse?.merchantRegistry ?? (await deploy("MerchantRegistry"));
  const licenceRegistry =
    options.reuse?.licenceRegistry ?? (await deploy("LicenceRegistry"));
  const auditAnchor =
    options.reuse?.auditAnchor ??
    (await deploy("AuditAnchor", [options.gateway]));
  if (options.reuse) {
    for (const [name, address] of Object.entries(options.reuse)) {
      assert.notEqual(
        await publicClient.getCode({ address }),
        undefined,
        `${name} has no code`,
      );
    }
    assert.equal(
      await publicClient.readContract({
        address: merchantRegistry,
        abi: MerchantRegistryAbi,
        functionName: "bank",
      }),
      bank.address,
      "Merchant registry belongs to another bank",
    );
    assert.equal(
      await publicClient.readContract({
        address: licenceRegistry,
        abi: LicenceRegistryAbi,
        functionName: "bank",
      }),
      bank.address,
      "Licence registry belongs to another bank",
    );
    assert.equal(
      await publicClient.readContract({
        address: auditAnchor,
        abi: AuditAnchorAbi,
        functionName: "gateway",
      }),
      options.gateway,
      "Audit anchor belongs to another gateway",
    );
  }
  const agentWallet = await deploy("AgentWallet", [
    ecnySim,
    merchantRegistry,
    options.gateway,
    options.perPaymentCap ?? 30_000n,
    options.dailyCap ?? 50_000n,
    options.monthlyCap ?? 100_000n,
    true,
  ]);
  await write(
    "ECnySim",
    ecnySim,
    "mint",
    [bank.address, options.mainOpeningBalance ?? 866_000n],
    "openingMint",
  );
  await write(
    "ECnySim",
    ecnySim,
    "configureAgentWallet",
    [agentWallet],
    "configureAgentWallet",
  );
  if (options.merchant) {
    const merchant = options.merchant;
    await write(
      "MerchantRegistry",
      merchantRegistry,
      "setMerchant",
      [
        merchant.id,
        merchant.payout,
        merchant.signingKey,
        merchant.legalName,
        merchant.uscc,
        merchant.category,
        true,
      ],
      "seedMerchant",
    );
  }
  return {
    chainId: 20200,
    rpcUrl,
    bank: bank.address,
    gateway: options.gateway,
    ecnySim,
    merchantRegistry,
    licenceRegistry,
    auditAnchor,
    agentWallet,
    txHashes,
  };
}

const isDirect =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const bankPrivateKey = process.env.FISCO_BANK_PRIVATE_KEY;
  const gateway = process.env.FISCO_GATEWAY_ADDRESS;
  if (!bankPrivateKey || !/^0x[0-9a-fA-F]{64}$/.test(bankPrivateKey)) {
    throw new Error("Set FISCO_BANK_PRIVATE_KEY to a fresh local test key");
  }
  if (!gateway || !/^0x[0-9a-fA-F]{40}$/.test(gateway)) {
    throw new Error(
      "Set FISCO_GATEWAY_ADDRESS to a distinct local signer address",
    );
  }
  const deployment = await deployAll({
    bankPrivateKey: bankPrivateKey as Hex,
    gateway: gateway as Address,
    rpcUrl: process.env.FISCO_RPC_URL,
  });
  const output = `${JSON.stringify(deployment, null, 2)}\n`;
  const outputPath = process.env.FISCO_DEPLOY_OUTPUT;
  if (outputPath) writeFileSync(outputPath, output, { mode: 0o600 });
  process.stdout.write(output);
}
