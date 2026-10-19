import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connectFisco, FISCO_CHAIN_ID } from "@webank/chain";
import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  parseAbiItem,
} from "viem";
import {
  attachHumanPaymentEvidence,
  inspectHumanPaymentRecovery,
} from "./human-recovery.js";

if (process.env.NODE_ENV === "production")
  throw new Error("Human payment recovery is local-demo only");

const [command, confirmationId, hash, ...flags] = process.argv.slice(2);
if (
  !/^(inspect|attach)$/.test(command ?? "") ||
  !/^hpm_[A-Za-z0-9_-]+$/.test(confirmationId ?? "") ||
  (command === "inspect" && (hash || flags.length > 0)) ||
  (command === "attach" &&
    (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? "") ||
      flags.length !== 2 ||
      !flags.includes("--attest-sole-bank-writer") ||
      !flags.includes("--attest-order-attribution")))
)
  throw new Error(
    "Usage: inspect <hpm_id> | attach <hpm_id> <tx_hash> --attest-sole-bank-writer --attest-order-attribution",
  );

const statePath = fileURLToPath(
  new URL(
    "../../../scripts/local-demo-runtime/gateway-state.json",
    import.meta.url,
  ),
);
const addressesPath = fileURLToPath(
  new URL("../../../scripts/chain/addresses.json", import.meta.url),
);
for (const path of [statePath, addressesPath]) {
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error("Recovery input permissions are unsafe");
}
const addresses = JSON.parse(readFileSync(addressesPath, "utf8")) as {
  chainId: number;
  rpcUrl: string;
  bank: `0x${string}`;
  ecnySim: `0x${string}`;
  agentWallet: `0x${string}`;
  migration?: { state: string };
};
if (
  addresses.chainId !== FISCO_CHAIN_ID ||
  addresses.rpcUrl !== "http://127.0.0.1:8545" ||
  addresses.migration?.state !== "active"
)
  throw new Error("Recovery deployment is not the active loopback demo");
const bank = getAddress(addresses.bank);
const token = getAddress(addresses.ecnySim);
const deployment = JSON.stringify({
  token: addresses.ecnySim,
  main: addresses.bank,
  wallet: addresses.agentWallet,
});
const client = createPublicClient({
  chain: defineChain({
    id: FISCO_CHAIN_ID,
    name: "FISCO BCOS local 20200",
    nativeCurrency: { name: "FISCO balance", symbol: "FISCO", decimals: 18 },
    rpcUrls: { default: { http: [addresses.rpcUrl] } },
  }),
  transport: http(addresses.rpcUrl),
});
if ((await client.getChainId()) !== FISCO_CHAIN_ID)
  throw new Error("Recovery chain ID mismatch");
const chain = await connectFisco({ rpcUrl: addresses.rpcUrl });
const transfer = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
);
const input = {
  statePath,
  context: JSON.stringify(addresses),
  deployment,
  confirmationId: confirmationId as string,
  async findCandidates(record: {
    payout: `0x${string}`;
    amount: number;
    startingBlock: string;
  }) {
    const tip = await client.getBlockNumber();
    const candidates: Array<{ hash: `0x${string}`; blockNumber: bigint }> = [];
    for (let start = BigInt(record.startingBlock); start <= tip; start += 10n) {
      // FISCO v3.17.1 silently truncates a wider log query after ten blocks.
      const end = start + 9n < tip ? start + 9n : tip;
      const logs = await client.getLogs({
        address: token,
        event: transfer,
        args: { from: bank, to: getAddress(record.payout) },
        fromBlock: start,
        toBlock: end,
      });
      for (const log of logs) {
        if (log.args.amount === BigInt(record.amount))
          candidates.push({
            hash: log.transactionHash,
            blockNumber: log.blockNumber,
          });
      }
    }
    return candidates;
  },
  async verify(
    candidateHash: `0x${string}`,
    record: {
      payout: `0x${string}`;
      amount: number;
    },
  ) {
    const evidence = await chain.getTransactionEvidence(candidateHash);
    if (
      evidence.status !== "success" ||
      evidence.transferEvents.filter(
        (event) =>
          event.token.toLowerCase() === token.toLowerCase() &&
          event.from.toLowerCase() === bank.toLowerCase() &&
          event.to.toLowerCase() === record.payout.toLowerCase() &&
          event.amount === BigInt(record.amount),
      ).length !== 1
    )
      throw new Error(
        "Candidate receipt is not one exact main-account transfer",
      );
    return { hash: candidateHash, blockNumber: evidence.blockNumber };
  },
};

const result =
  command === "inspect"
    ? await inspectHumanPaymentRecovery(input)
    : await attachHumanPaymentEvidence({
        ...input,
        hash: hash as `0x${string}`,
        attestSoleBankWriter: true,
        attestOrderAttribution: true,
      });
process.stdout.write(
  `${JSON.stringify(result, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  )}\n`,
);
