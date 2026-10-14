import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  type Hex,
  http,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { normalizeChainError } from "./errors.js";
import {
  AgentWalletAbi,
  AuditAnchorAbi,
  LicenceRegistryAbi,
  MerchantRegistryAbi,
} from "./generated/abis.js";

export { ChainRevertError, decodeChainRevert } from "./errors.js";
export {
  AgentWalletAbi,
  AuditAnchorAbi,
  ECnySimAbi,
  LicenceRegistryAbi,
  MerchantRegistryAbi,
} from "./generated/abis.js";

export const FISCO_CHAIN_ID = 20200;
export const DEFAULT_FISCO_RPC_URL = "http://127.0.0.1:8545";

export type ChainAddresses = {
  agentWallet: Address;
  auditAnchor: Address;
  ecnySim: Address;
  merchantRegistry: Address;
  licenceRegistry: Address;
};

export type ChainConnectionOptions = {
  rpcUrl?: string;
  privateKey?: Hex;
};

export type TransactionEvidence = {
  hash: Hex;
  status: "success" | "reverted";
  blockNumber: bigint;
  transactionIndex: number;
  blockTimestampMs: number;
  blockTimeIso: string;
  paidEvents: Array<{
    paymentId: Hex;
    merchantId: Hex;
    payout: Address;
    amount: bigint;
  }>;
  anchoredEvents: Array<{
    recordHash: Hex;
    subjectId: Hex;
    kind: number;
    atMs: number;
  }>;
};

export type MerchantRecord = {
  payout: Address;
  signingKey: Hex;
  legalName: string;
  uscc: string;
  category: string;
  active: boolean;
};

export type LicenceRecord = {
  keyHash: Hex;
  level: number;
  updatedAt: bigint;
};

export type FiscoChain = {
  signerAddress?: Address;
  anchor(
    address: Address,
    recordHash: Hex,
    subjectId: Hex,
    kind: number,
  ): Promise<Hex>;
  pay(
    address: Address,
    paymentId: Hex,
    merchantId: Hex,
    amount: bigint,
  ): Promise<Hex>;
  setFrozen(address: Address, frozen: boolean): Promise<Hex>;
  setCaps(
    address: Address,
    perPayment: bigint,
    daily: bigint,
    monthly: bigint,
  ): Promise<Hex>;
  setLicence(
    address: Address,
    agentId: Hex,
    keyHash: Hex,
    level: 1 | 2 | 3 | 4,
  ): Promise<Hex>;
  getMerchant(address: Address, merchantId: Hex): Promise<MerchantRecord>;
  getLicence(address: Address, agentId: Hex): Promise<LicenceRecord>;
  getTransactionEvidence(hash: Hex): Promise<TransactionEvidence>;
};

/** Converts FISCO's millisecond block timestamps and normal EVM seconds to milliseconds. */
export function normalizeBlockTimestamp(timestamp: bigint): number {
  const ms = timestamp >= 1_000_000_000_000n ? timestamp : timestamp * 1000n;
  const value = Number(ms);
  if (!Number.isSafeInteger(value))
    throw new RangeError("Block timestamp exceeds JS safe integer range");
  return value;
}

function requiredEventArg<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Chain event omitted ${name}`);
  return value;
}

export async function connectFisco(
  options: ChainConnectionOptions = {},
): Promise<FiscoChain> {
  const rpcUrl = options.rpcUrl ?? DEFAULT_FISCO_RPC_URL;
  const chain = defineChain({
    id: FISCO_CHAIN_ID,
    name: "FISCO BCOS local 20200",
    nativeCurrency: { name: "FISCO balance", symbol: "FISCO", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== FISCO_CHAIN_ID) {
    throw new Error(
      `Expected FISCO chain ${FISCO_CHAIN_ID}, received ${actualChainId}`,
    );
  }
  const account = options.privateKey
    ? privateKeyToAccount(options.privateKey)
    : undefined;
  const walletClient = account
    ? createWalletClient({ account, chain, transport: http(rpcUrl) })
    : undefined;

  async function send(hash: Hex) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success")
      throw new Error(`Transaction ${hash} reverted`);
    return hash;
  }

  function signer() {
    if (!walletClient || !account)
      throw new Error("A private key is required for chain writes");
    return { walletClient, account };
  }

  return {
    signerAddress: account?.address,
    async anchor(
      address: Address,
      recordHash: Hex,
      subjectId: Hex,
      kind: number,
    ) {
      if (!Number.isInteger(kind) || kind < 0 || kind > 255)
        throw new RangeError("Invalid audit kind");
      const { walletClient, account } = signer();
      try {
        const { request } = await publicClient.simulateContract({
          address,
          abi: AuditAnchorAbi,
          functionName: "anchor",
          args: [recordHash, subjectId, kind],
          account,
        });
        return send(
          await walletClient.writeContract({ ...request, account, chain }),
        );
      } catch (error) {
        throw normalizeChainError(error, AuditAnchorAbi);
      }
    },
    async pay(
      address: Address,
      paymentId: Hex,
      merchantId: Hex,
      amount: bigint,
    ) {
      const { walletClient, account } = signer();
      try {
        const { request } = await publicClient.simulateContract({
          address,
          abi: AgentWalletAbi,
          functionName: "pay",
          args: [paymentId, merchantId, amount],
          account,
        });
        return send(
          await walletClient.writeContract({ ...request, account, chain }),
        );
      } catch (error) {
        throw normalizeChainError(error, AgentWalletAbi);
      }
    },
    async setFrozen(address: Address, frozen: boolean) {
      const { walletClient, account } = signer();
      try {
        const { request } = await publicClient.simulateContract({
          address,
          abi: AgentWalletAbi,
          functionName: "setFrozen",
          args: [frozen],
          account,
        });
        return send(
          await walletClient.writeContract({ ...request, account, chain }),
        );
      } catch (error) {
        throw normalizeChainError(error, AgentWalletAbi);
      }
    },
    async setCaps(
      address: Address,
      perPayment: bigint,
      daily: bigint,
      monthly: bigint,
    ) {
      const { walletClient, account } = signer();
      try {
        const { request } = await publicClient.simulateContract({
          address,
          abi: AgentWalletAbi,
          functionName: "setCaps",
          args: [perPayment, daily, monthly],
          account,
        });
        return send(
          await walletClient.writeContract({ ...request, account, chain }),
        );
      } catch (error) {
        throw normalizeChainError(error, AgentWalletAbi);
      }
    },
    async setLicence(
      address: Address,
      agentId: Hex,
      keyHash: Hex,
      level: 1 | 2 | 3 | 4,
    ) {
      const { walletClient, account } = signer();
      try {
        const { request } = await publicClient.simulateContract({
          address,
          abi: LicenceRegistryAbi,
          functionName: "setLicence",
          args: [agentId, keyHash, level],
          account,
        });
        return send(
          await walletClient.writeContract({ ...request, account, chain }),
        );
      } catch (error) {
        throw normalizeChainError(error, LicenceRegistryAbi);
      }
    },
    async getMerchant(address: Address, merchantId: Hex) {
      return publicClient.readContract({
        address,
        abi: MerchantRegistryAbi,
        functionName: "getMerchant",
        args: [merchantId],
      });
    },
    async getLicence(address: Address, agentId: Hex) {
      return publicClient.readContract({
        address,
        abi: LicenceRegistryAbi,
        functionName: "getLicence",
        args: [agentId],
      });
    },
    async getTransactionEvidence(hash: Hex): Promise<TransactionEvidence> {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      const block = await publicClient.getBlock({
        blockNumber: receipt.blockNumber,
      });
      const blockTimestampMs = normalizeBlockTimestamp(block.timestamp);
      const paidEvents = parseEventLogs({
        abi: AgentWalletAbi,
        logs: receipt.logs,
        eventName: "Paid",
        strict: false,
      });
      const anchoredEvents = parseEventLogs({
        abi: AuditAnchorAbi,
        logs: receipt.logs,
        eventName: "Anchored",
        strict: false,
      });
      return {
        hash,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        transactionIndex: receipt.transactionIndex,
        blockTimestampMs,
        blockTimeIso: new Date(blockTimestampMs).toISOString(),
        paidEvents: paidEvents.map((event) => ({
          paymentId: requiredEventArg(event.args.paymentId, "paymentId"),
          merchantId: requiredEventArg(event.args.merchantId, "merchantId"),
          payout: requiredEventArg(event.args.payout, "payout"),
          amount: requiredEventArg(event.args.amount, "amount"),
        })),
        anchoredEvents: anchoredEvents.map((event) => ({
          recordHash: requiredEventArg(event.args.recordHash, "recordHash"),
          subjectId: requiredEventArg(event.args.subjectId, "subjectId"),
          kind: requiredEventArg(event.args.kind, "kind"),
          atMs: normalizeBlockTimestamp(requiredEventArg(event.args.at, "at")),
        })),
      };
    },
  };
}
