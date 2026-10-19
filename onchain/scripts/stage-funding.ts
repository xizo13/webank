import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentWalletAbi,
  AuditAnchorAbi,
  ECnySimAbi,
  LicenceRegistryAbi,
  MerchantRegistryAbi,
} from "@webank/chain";
import {
  createPublicClient,
  defineChain,
  type Hex,
  http,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type Deployment, deployAll } from "./deploy.js";

export type FundingStage = Deployment & {
  deploymentFingerprint: string;
  migration: {
    state: "staged";
    priorAddresses: Pick<Deployment, "ecnySim" | "agentWallet">;
    priorDeploymentFingerprint: string;
    priorReceiptHash?: Hex;
  };
};

const onchainRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fingerprint(): string {
  const digest = createHash("sha256");
  const paths = [
    "scripts/compile.mjs",
    "scripts/deploy.ts",
    "package.json",
    ...[
      "AgentWallet",
      "AuditAnchor",
      "ECnySim",
      "LicenceRegistry",
      "MerchantRegistry",
    ].map((name) => `src/${name}.sol`),
  ];
  // Match scripts/chain/manage.py, which sorts Solidity files first.
  const ordered = [
    ...paths.filter((path) => path.startsWith("src/")).sort(),
    "scripts/compile.mjs",
    "scripts/deploy.ts",
    "package.json",
  ];
  for (const path of ordered) {
    digest.update(relative(onchainRoot, resolve(onchainRoot, path)));
    digest.update(Buffer.from([0]));
    digest.update(readFileSync(resolve(onchainRoot, path)));
    digest.update(Buffer.from([0]));
  }
  return digest.digest("hex");
}

export async function stageFundingMigration(options: {
  bankPrivateKey: Hex;
  old: Deployment & { deploymentFingerprint: string };
  rpcUrl?: string;
  priorReceiptHash?: Hex;
  mainOpeningBalance?: bigint;
}): Promise<FundingStage> {
  const rpcUrl = options.rpcUrl ?? "http://127.0.0.1:8545";
  const old = options.old;
  const bank = privateKeyToAccount(options.bankPrivateKey);
  assert.equal(old.chainId, 20200, "Prior deployment has wrong chain ID");
  assert.equal(
    old.bank.toLowerCase(),
    bank.address.toLowerCase(),
    "Prior bank signer mismatch",
  );
  const chain = defineChain({
    id: 20200,
    name: "FISCO BCOS local 20200",
    nativeCurrency: { name: "FISCO balance", symbol: "FISCO", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  assert.equal(await client.getChainId(), 20200, "Wrong Web3 RPC chain ID");
  for (const address of [
    old.ecnySim,
    old.agentWallet,
    old.merchantRegistry,
    old.licenceRegistry,
    old.auditAnchor,
  ]) {
    assert.notEqual(
      await client.getCode({ address }),
      undefined,
      `Prior contract missing: ${address}`,
    );
  }
  const [
    oldToken,
    oldBank,
    oldRegistry,
    oldGateway,
    registryBank,
    licenceBank,
    auditGateway,
  ] = await Promise.all([
    client.readContract({
      address: old.agentWallet,
      abi: AgentWalletAbi,
      functionName: "token",
    }),
    client.readContract({
      address: old.agentWallet,
      abi: AgentWalletAbi,
      functionName: "bank",
    }),
    client.readContract({
      address: old.agentWallet,
      abi: AgentWalletAbi,
      functionName: "merchantRegistry",
    }),
    client.readContract({
      address: old.agentWallet,
      abi: AgentWalletAbi,
      functionName: "gateway",
    }),
    client.readContract({
      address: old.merchantRegistry,
      abi: MerchantRegistryAbi,
      functionName: "bank",
    }),
    client.readContract({
      address: old.licenceRegistry,
      abi: LicenceRegistryAbi,
      functionName: "bank",
    }),
    client.readContract({
      address: old.auditAnchor,
      abi: AuditAnchorAbi,
      functionName: "gateway",
    }),
  ]);
  assert.equal(
    oldToken.toLowerCase(),
    old.ecnySim.toLowerCase(),
    "Prior wallet token mismatch",
  );
  assert.equal(
    oldBank.toLowerCase(),
    old.bank.toLowerCase(),
    "Prior wallet bank mismatch",
  );
  assert.equal(
    oldRegistry.toLowerCase(),
    old.merchantRegistry.toLowerCase(),
    "Prior wallet registry mismatch",
  );
  assert.equal(
    oldGateway.toLowerCase(),
    old.gateway.toLowerCase(),
    "Prior wallet gateway mismatch",
  );
  assert.equal(
    registryBank.toLowerCase(),
    old.bank.toLowerCase(),
    "Merchant registry bank mismatch",
  );
  assert.equal(
    licenceBank.toLowerCase(),
    old.bank.toLowerCase(),
    "Licence registry bank mismatch",
  );
  assert.equal(
    auditGateway.toLowerCase(),
    old.gateway.toLowerCase(),
    "Audit gateway mismatch",
  );
  if (options.priorReceiptHash) {
    const receipt = await client.getTransactionReceipt({
      hash: options.priorReceiptHash,
    });
    assert.equal(receipt.status, "success", "Prior receipt not successful");
    assert.equal(
      receipt.transactionHash.toLowerCase(),
      options.priorReceiptHash.toLowerCase(),
      "Prior receipt hash mismatch",
    );
    const paid = parseEventLogs({
      abi: AgentWalletAbi,
      logs: receipt.logs,
      eventName: "Paid",
      strict: false,
    });
    assert.ok(
      paid.some(
        (event) =>
          event.address.toLowerCase() === old.agentWallet.toLowerCase(),
      ),
      "Prior receipt is not a Paid event from old wallet",
    );
  }
  const deployment = await deployAll({
    bankPrivateKey: options.bankPrivateKey,
    gateway: old.gateway,
    rpcUrl,
    mainOpeningBalance: options.mainOpeningBalance,
    reuse: {
      merchantRegistry: old.merchantRegistry,
      licenceRegistry: old.licenceRegistry,
      auditAnchor: old.auditAnchor,
    },
  });
  assert.equal(
    await client.readContract({
      address: deployment.ecnySim,
      abi: ECnySimAbi,
      functionName: "balanceOf",
      args: [deployment.agentWallet],
    }),
    0n,
    "Staged wallet is not empty",
  );
  assert.equal(
    await client.readContract({
      address: deployment.ecnySim,
      abi: ECnySimAbi,
      functionName: "balanceOf",
      args: [old.bank],
    }),
    options.mainOpeningBalance ?? 866_000n,
    "Staged main opening balance mismatch",
  );
  return {
    ...deployment,
    deploymentFingerprint: fingerprint(),
    migration: {
      state: "staged",
      priorAddresses: { ecnySim: old.ecnySim, agentWallet: old.agentWallet },
      priorDeploymentFingerprint: old.deploymentFingerprint,
      priorReceiptHash: options.priorReceiptHash,
    },
  };
}

const isDirect =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const key = process.env.FISCO_BANK_PRIVATE_KEY;
  const prior = process.env.FISCO_PRIOR_ADDRESSES;
  const staged = process.env.FISCO_STAGED_OUTPUT;
  assert.match(
    key ?? "",
    /^0x[0-9a-fA-F]{64}$/,
    "FISCO_BANK_PRIVATE_KEY is required",
  );
  assert.ok(
    prior && staged,
    "FISCO_PRIOR_ADDRESSES and FISCO_STAGED_OUTPUT are required",
  );
  assert.notEqual(
    resolve(prior),
    resolve(staged),
    "Staged output must not replace active addresses",
  );
  const ignoredRuntime = resolve(onchainRoot, "../scripts/chain/runtime") + sep;
  assert.ok(
    resolve(staged).startsWith(ignoredRuntime),
    "Staged output must be in the ignored chain runtime directory",
  );
  assert.equal(existsSync(staged), false, "Staged output already exists");
  const result = await stageFundingMigration({
    bankPrivateKey: key as Hex,
    old: JSON.parse(readFileSync(prior, "utf8")),
    rpcUrl: process.env.FISCO_RPC_URL,
    priorReceiptHash: process.env.FISCO_PRIOR_RECEIPT_HASH as Hex | undefined,
  });
  writeFileSync(staged, `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(
    `Staged contracts at ${staged}; active addresses unchanged\n`,
  );
}
