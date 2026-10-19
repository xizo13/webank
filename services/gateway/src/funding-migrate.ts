/** Manual, offline cutover. Run only after stopping the local demo. */
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AgentWalletAbi, connectFisco, ECnySimAbi } from "@webank/chain";
import {
  type Address,
  createPublicClient,
  defineChain,
  type Hex,
  http,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { migrateFundingDeployment } from "./funding-migration.js";

if (process.argv.length !== 3 || process.argv[2] !== "--cutover")
  throw new Error("Run with --cutover after stopping the local demo");

const path = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));
const activePath = path("../../../scripts/chain/addresses.json");
const stagedPath = path("../../../scripts/chain/runtime/funding-stage.json");
const statePath = path(
  "../../../scripts/local-demo-runtime/gateway-state.json",
);
const identityPath = `${statePath}.identity`;
const markerPath = path(
  "../../../scripts/local-demo-runtime/funding-cutover.json",
);
const archiveDir = path(
  "../../../scripts/local-demo-runtime/funding-cutover-archives",
);
const bankKeyPath = path("../../../scripts/chain/runtime/bank.env");
const staged = JSON.parse(readFileSync(stagedPath, "utf8")) as {
  bank: Address;
  rpcUrl: string;
  ecnySim: Address;
  agentWallet: Address;
  migration?: { priorAddresses: { ecnySim: Address; agentWallet: Address } };
};
if (staged.rpcUrl !== "http://127.0.0.1:8545" || !staged.migration)
  throw new Error("Staged local funding deployment is invalid");
const priorToken = staged.migration.priorAddresses.ecnySim;
const client = createPublicClient({
  chain: defineChain({
    id: 20200,
    name: "FISCO BCOS local 20200",
    nativeCurrency: { name: "FISCO balance", symbol: "FISCO", decimals: 18 },
    rpcUrls: { default: { http: [staged.rpcUrl] } },
  }),
  transport: http(staged.rpcUrl),
});
if ((await client.getChainId()) !== 20200) throw new Error("Wrong local chain");

const result = await migrateFundingDeployment({
  activePath,
  stagedPath,
  statePath,
  identityPath,
  markerPath,
  archiveDir,
  verifyOldPaid: async (wallet, hash) => {
    const receipt = await client.getTransactionReceipt({ hash: hash as Hex });
    if (receipt.status !== "success") return false;
    const paid = parseEventLogs({
      abi: AgentWalletAbi,
      eventName: "Paid",
      logs: receipt.logs,
      strict: false,
    }).filter((event) => event.address.toLowerCase() === wallet.toLowerCase());
    const paidEvent = paid[0];
    if (paid.length !== 1 || !paidEvent) return false;
    const transfers = parseEventLogs({
      abi: ECnySimAbi,
      eventName: "Transfer",
      logs: receipt.logs,
      strict: false,
    }).filter(
      (event) =>
        event.address.toLowerCase() === priorToken.toLowerCase() &&
        event.args.from?.toLowerCase() === wallet.toLowerCase() &&
        event.args.to?.toLowerCase() === paidEvent.args.payout?.toLowerCase() &&
        event.args.amount === paidEvent.args.amount,
    );
    return transfers.length === 1;
  },
  verifyStaged: async (deployment) => {
    const token = deployment.ecnySim as Address;
    const wallet = deployment.agentWallet as Address;
    const [
      tokenCode,
      walletCode,
      configuredWallet,
      walletToken,
      walletBank,
      snapshot,
    ] = await Promise.all([
      client.getCode({ address: token }),
      client.getCode({ address: wallet }),
      client.readContract({
        address: token,
        abi: ECnySimAbi,
        functionName: "agentWallet",
      }),
      client.readContract({
        address: wallet,
        abi: AgentWalletAbi,
        functionName: "token",
      }),
      client.readContract({
        address: wallet,
        abi: AgentWalletAbi,
        functionName: "bank",
      }),
      (await connectFisco({ rpcUrl: staged.rpcUrl })).getWalletSnapshot(
        token,
        deployment.bank as Address,
        wallet,
      ),
    ]);
    return (
      !!tokenCode &&
      tokenCode !== "0x" &&
      !!walletCode &&
      walletCode !== "0x" &&
      configuredWallet.toLowerCase() === wallet.toLowerCase() &&
      walletToken.toLowerCase() === token.toLowerCase() &&
      walletBank.toLowerCase() === deployment.bank.toLowerCase() &&
      snapshot.walletBalance === 0n &&
      !snapshot.walletFrozen
    );
  },
  freezeOldWallet: async (wallet) => {
    const oldWallet = wallet as Address;
    const alreadyFrozen = await client.readContract({
      address: oldWallet,
      abi: AgentWalletAbi,
      functionName: "frozen",
    });
    if (alreadyFrozen) return;
    const info = statSync(bankKeyPath);
    if (!info.isFile() || (info.mode & 0o077) !== 0)
      throw new Error("Bank signer file permissions are unsafe");
    const match = /^FISCO_BANK_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\n?$/.exec(
      readFileSync(bankKeyPath, "utf8"),
    );
    if (!match) throw new Error("Bank signer file is invalid");
    const key = match[1] as Hex;
    if (
      privateKeyToAccount(key).address.toLowerCase() !==
      staged.bank.toLowerCase()
    )
      throw new Error("Bank signer does not match deployment");
    const oldBank = await client.readContract({
      address: oldWallet,
      abi: AgentWalletAbi,
      functionName: "bank",
    });
    if (oldBank.toLowerCase() !== staged.bank.toLowerCase())
      throw new Error("Prior wallet belongs to another bank");
    await (
      await connectFisco({ rpcUrl: staged.rpcUrl, privateKey: key })
    ).setFrozen(oldWallet, true);
    if (
      !(await client.readContract({
        address: oldWallet,
        abi: AgentWalletAbi,
        functionName: "frozen",
      }))
    )
      throw new Error("Prior wallet freeze is unconfirmed");
  },
});
process.stdout.write(
  `Funding cutover complete. Owner-only backup: ${result.backupDir}\n`,
);
