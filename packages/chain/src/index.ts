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
  ECnySimAbi,
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
  transferEvents: Array<{
    token: Address;
    from: Address;
    to: Address;
    amount: bigint;
  }>;
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
  fundedEvents: Array<{
    token: Address;
    fundingId: Hex;
    main: Address;
    wallet: Address;
    amount: bigint;
  }>;
  sweptEvents: Array<{
    wallet: Address;
    sweepId: Hex;
    main: Address;
    amount: bigint;
  }>;
};

export type FundingEvidence = TransactionEvidence["fundedEvents"][number] & {
  hash: Hex;
  blockNumber: bigint;
};

export type WalletSnapshot = {
  mainBalance: bigint;
  walletBalance: bigint;
  walletFrozen: boolean;
  blockNumber: bigint;
  observedAt: string;
};

export type SweepEvidence = {
  hash: Hex;
  blockNumber: bigint;
  wallet: Address;
  sweepId: Hex;
  main: Address;
  token: Address;
  amount: bigint;
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
  /** Executes the exact wallet pay call in read-only simulation; no transaction is sent. */
  simulatePay(
    address: Address,
    paymentId: Hex,
    merchantId: Hex,
    amount: bigint,
  ): Promise<void>;
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
    level: 1 | 2 | 4,
  ): Promise<Hex>;
  getMerchant(address: Address, merchantId: Hex): Promise<MerchantRecord>;
  getLicence(address: Address, agentId: Hex): Promise<LicenceRecord>;
  getTokenBalance(token: Address, account: Address): Promise<bigint>;
  getWalletSnapshot(
    token: Address,
    main: Address,
    wallet: Address,
  ): Promise<WalletSnapshot>;
  getPolicyCapsSnapshot(address: Address): Promise<{
    perPaymentCap: bigint;
    dailyCap: bigint;
    monthlyCap: bigint;
    spentToday: bigint;
    spentMonth: bigint;
    blockNumber: bigint;
    observedAt: string;
    nextDailyResetAt: string;
    nextMonthlyResetAt: string;
  }>;
  isFundingApplied(token: Address, fundingId: Hex): Promise<boolean>;
  fundAgentWallet(token: Address, fundingId: Hex, amount: bigint): Promise<Hex>;
  transferMain(token: Address, payout: Address, amount: bigint): Promise<Hex>;
  sweepToMain(wallet: Address, sweepId: Hex, amount: bigint): Promise<Hex>;
  getFundingEvidence(
    hash: Hex,
    token: Address,
    fundingId: Hex,
  ): Promise<FundingEvidence>;
  findFundingEvidence(
    token: Address,
    fundingId: Hex,
    fromBlock: bigint,
  ): Promise<FundingEvidence | undefined>;
  getSweepEvidence(
    hash: Hex,
    wallet: Address,
    sweepId: Hex,
  ): Promise<SweepEvidence>;
  findSweepEvidence(
    wallet: Address,
    sweepId: Hex,
    fromBlock: bigint,
  ): Promise<SweepEvidence | undefined>;
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

  async function sweepEvidence(
    hash: Hex,
    wallet: Address,
    sweepId: Hex,
  ): Promise<SweepEvidence> {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    if (receipt.status !== "success")
      throw new Error("Sweep transaction reverted");
    const events = parseEventLogs({
      abi: AgentWalletAbi,
      logs: receipt.logs,
      eventName: "Swept",
      strict: false,
    }).filter(
      (event) =>
        event.address.toLowerCase() === wallet.toLowerCase() &&
        event.args.sweepId?.toLowerCase() === sweepId.toLowerCase(),
    );
    const event = events[0];
    if (events.length !== 1 || !event)
      throw new Error("Expected exactly one matching Swept event");
    const [token, bank] = await Promise.all([
      publicClient.readContract({
        address: wallet,
        abi: AgentWalletAbi,
        functionName: "token",
        blockNumber: receipt.blockNumber,
      }),
      publicClient.readContract({
        address: wallet,
        abi: AgentWalletAbi,
        functionName: "bank",
        blockNumber: receipt.blockNumber,
      }),
    ]);
    const main = requiredEventArg(event.args.main, "main");
    const amount = requiredEventArg(event.args.amount, "amount");
    if (main.toLowerCase() !== bank.toLowerCase())
      throw new Error("Sweep destination differs from fixed bank main account");
    const transfers = parseEventLogs({
      abi: ECnySimAbi,
      logs: receipt.logs,
      eventName: "Transfer",
      strict: false,
    }).filter(
      (log) =>
        log.address.toLowerCase() === token.toLowerCase() &&
        log.args.from?.toLowerCase() === wallet.toLowerCase() &&
        log.args.to?.toLowerCase() === bank.toLowerCase() &&
        log.args.amount === amount,
    );
    if (transfers.length !== 1)
      throw new Error("Sweep has no matching token transfer to main");
    return {
      hash,
      blockNumber: receipt.blockNumber,
      wallet: event.address,
      sweepId: requiredEventArg(event.args.sweepId, "sweepId"),
      main,
      token,
      amount,
    };
  }

  async function findUniqueEventHash(
    fromBlock: bigint,
    readRange: (
      from: bigint,
      to: bigint,
    ) => Promise<readonly { transactionHash: Hex }[]>,
  ): Promise<Hex | undefined> {
    if (fromBlock < 0n) throw new RangeError("fromBlock must be nonnegative");
    const tip = await publicClient.getBlockNumber();
    let found: Hex | undefined;
    // FISCO v3.17.1 silently stops after ten blocks even when toBlock is later.
    for (let start = fromBlock; start <= tip; start += 10n) {
      const end = start + 9n < tip ? start + 9n : tip;
      for (const log of await readRange(start, end)) {
        if (found) throw new Error("Multiple events for one operation ID");
        found = log.transactionHash;
      }
    }
    return found;
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
    async simulatePay(
      address: Address,
      paymentId: Hex,
      merchantId: Hex,
      amount: bigint,
    ) {
      const { account } = signer();
      try {
        await publicClient.simulateContract({
          address,
          abi: AgentWalletAbi,
          functionName: "pay",
          args: [paymentId, merchantId, amount],
          account,
        });
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
      level: 1 | 2 | 4,
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
    async getTokenBalance(token: Address, owner: Address) {
      return publicClient.readContract({
        address: token,
        abi: ECnySimAbi,
        functionName: "balanceOf",
        args: [owner],
      });
    },
    async getWalletSnapshot(token: Address, main: Address, wallet: Address) {
      const blockNumber = await publicClient.getBlockNumber();
      const [
        mainBalance,
        walletBalance,
        walletFrozen,
        walletToken,
        walletBank,
      ] = await Promise.all([
        publicClient.readContract({
          address: token,
          abi: ECnySimAbi,
          functionName: "balanceOf",
          args: [main],
          blockNumber,
        }),
        publicClient.readContract({
          address: token,
          abi: ECnySimAbi,
          functionName: "balanceOf",
          args: [wallet],
          blockNumber,
        }),
        publicClient.readContract({
          address: wallet,
          abi: AgentWalletAbi,
          functionName: "frozen",
          blockNumber,
        }),
        publicClient.readContract({
          address: wallet,
          abi: AgentWalletAbi,
          functionName: "token",
          blockNumber,
        }),
        publicClient.readContract({
          address: wallet,
          abi: AgentWalletAbi,
          functionName: "bank",
          blockNumber,
        }),
      ]);
      if (walletToken.toLowerCase() !== token.toLowerCase())
        throw new Error("Wallet token differs from snapshot token");
      if (walletBank.toLowerCase() !== main.toLowerCase())
        throw new Error("Wallet bank differs from snapshot main account");
      return {
        mainBalance,
        walletBalance,
        walletFrozen,
        blockNumber,
        observedAt: new Date().toISOString(),
      };
    },
    async getPolicyCapsSnapshot(address: Address) {
      const blockNumber = await publicClient.getBlockNumber();
      const [
        perPaymentCap,
        dailyCap,
        monthlyCap,
        dayIndex,
        monthIndex,
        nativeTimestamp,
        milliseconds,
      ] = await Promise.all([
        publicClient.readContract({
          address,
          abi: AgentWalletAbi,
          functionName: "perPaymentCap",
          blockNumber,
        }),
        publicClient.readContract({
          address,
          abi: AgentWalletAbi,
          functionName: "dailyCap",
          blockNumber,
        }),
        publicClient.readContract({
          address,
          abi: AgentWalletAbi,
          functionName: "monthlyCap",
          blockNumber,
        }),
        publicClient.readContract({
          address,
          abi: AgentWalletAbi,
          functionName: "currentDayIndex",
          blockNumber,
        }),
        publicClient.readContract({
          address,
          abi: AgentWalletAbi,
          functionName: "currentMonthIndex",
          blockNumber,
        }),
        publicClient.readContract({
          address,
          abi: AgentWalletAbi,
          functionName: "currentTimestamp",
          blockNumber,
        }),
        publicClient.readContract({
          address,
          abi: AgentWalletAbi,
          functionName: "timestampIsMilliseconds",
          blockNumber,
        }),
      ]);
      const [spentToday, spentMonth] = await Promise.all([
        publicClient.readContract({
          address,
          abi: AgentWalletAbi,
          functionName: "spentByDay",
          args: [dayIndex],
          blockNumber,
        }),
        publicClient.readContract({
          address,
          abi: AgentWalletAbi,
          functionName: "spentByMonth",
          args: [monthIndex],
          blockNumber,
        }),
      ]);
      const observedMs = Number(
        milliseconds ? nativeTimestamp : nativeTimestamp * 1000n,
      );
      if (!Number.isSafeInteger(observedMs))
        throw new Error("Invalid wallet timestamp");
      const observed = new Date(observedMs);
      if (Number.isNaN(observed.getTime()))
        throw new Error("Invalid wallet timestamp");
      const nextMonth = new Date(
        Date.UTC(observed.getUTCFullYear(), observed.getUTCMonth() + 1, 1),
      );
      return {
        perPaymentCap,
        dailyCap,
        monthlyCap,
        spentToday,
        spentMonth,
        blockNumber,
        observedAt: observed.toISOString(),
        nextDailyResetAt: new Date(
          (Number(dayIndex) + 1) * 86_400_000,
        ).toISOString(),
        nextMonthlyResetAt: nextMonth.toISOString(),
      };
    },
    async isFundingApplied(token: Address, fundingId: Hex) {
      return publicClient.readContract({
        address: token,
        abi: ECnySimAbi,
        functionName: "funded",
        args: [fundingId],
      });
    },
    async fundAgentWallet(token: Address, fundingId: Hex, amount: bigint) {
      const { walletClient, account } = signer();
      try {
        const { request } = await publicClient.simulateContract({
          address: token,
          abi: ECnySimAbi,
          functionName: "fundAgentWallet",
          args: [fundingId, amount],
          account,
        });
        return send(
          await walletClient.writeContract({ ...request, account, chain }),
        );
      } catch (error) {
        throw normalizeChainError(error, ECnySimAbi);
      }
    },
    async transferMain(token: Address, payout: Address, amount: bigint) {
      const { walletClient, account } = signer();
      try {
        const { request } = await publicClient.simulateContract({
          address: token,
          abi: ECnySimAbi,
          functionName: "transfer",
          args: [payout, amount],
          account,
        });
        return send(
          await walletClient.writeContract({ ...request, account, chain }),
        );
      } catch (error) {
        throw normalizeChainError(error, ECnySimAbi);
      }
    },
    async sweepToMain(wallet: Address, sweepId: Hex, amount: bigint) {
      const { walletClient, account } = signer();
      try {
        const { request } = await publicClient.simulateContract({
          address: wallet,
          abi: AgentWalletAbi,
          functionName: "sweepToMain",
          args: [sweepId, amount],
          account,
        });
        return send(
          await walletClient.writeContract({ ...request, account, chain }),
        );
      } catch (error) {
        throw normalizeChainError(error, AgentWalletAbi);
      }
    },
    async getFundingEvidence(hash: Hex, token: Address, fundingId: Hex) {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new Error("Funding transaction reverted");
      const matches = parseEventLogs({
        abi: ECnySimAbi,
        logs: receipt.logs,
        eventName: "Funded",
        strict: false,
      }).filter(
        (event) =>
          event.address.toLowerCase() === token.toLowerCase() &&
          event.args.fundingId?.toLowerCase() === fundingId.toLowerCase(),
      );
      if (matches.length !== 1)
        throw new Error("Expected exactly one matching Funded event");
      const event = matches[0];
      if (!event) throw new Error("Funded event missing");
      return {
        hash,
        blockNumber: receipt.blockNumber,
        token: event.address,
        fundingId: requiredEventArg(event.args.fundingId, "fundingId"),
        main: requiredEventArg(event.args.main, "main"),
        wallet: requiredEventArg(event.args.wallet, "wallet"),
        amount: requiredEventArg(event.args.amount, "amount"),
      };
    },
    async findFundingEvidence(
      token: Address,
      fundingId: Hex,
      fromBlock: bigint,
    ) {
      const hash = await findUniqueEventHash(fromBlock, (start, end) =>
        publicClient.getContractEvents({
          address: token,
          abi: ECnySimAbi,
          eventName: "Funded",
          args: { fundingId },
          fromBlock: start,
          toBlock: end,
        }),
      );
      if (!hash) {
        if (
          await publicClient.readContract({
            address: token,
            abi: ECnySimAbi,
            functionName: "funded",
            args: [fundingId],
          })
        )
          throw new Error(
            "Funding ID is applied but no matching event was found from starting block",
          );
        return undefined;
      }
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new Error("Funding event has reverted receipt");
      const matches = parseEventLogs({
        abi: ECnySimAbi,
        logs: receipt.logs,
        eventName: "Funded",
        strict: false,
      }).filter(
        (event) =>
          event.address.toLowerCase() === token.toLowerCase() &&
          event.args.fundingId?.toLowerCase() === fundingId.toLowerCase(),
      );
      const event = matches[0];
      if (matches.length !== 1 || !event)
        throw new Error("Funding log does not match receipt");
      return {
        hash,
        blockNumber: receipt.blockNumber,
        token: event.address,
        fundingId: requiredEventArg(event.args.fundingId, "fundingId"),
        main: requiredEventArg(event.args.main, "main"),
        wallet: requiredEventArg(event.args.wallet, "wallet"),
        amount: requiredEventArg(event.args.amount, "amount"),
      };
    },
    async getSweepEvidence(hash: Hex, wallet: Address, sweepId: Hex) {
      return sweepEvidence(hash, wallet, sweepId);
    },
    async findSweepEvidence(wallet: Address, sweepId: Hex, fromBlock: bigint) {
      const hash = await findUniqueEventHash(fromBlock, (start, end) =>
        publicClient.getContractEvents({
          address: wallet,
          abi: AgentWalletAbi,
          eventName: "Swept",
          args: { sweepId },
          fromBlock: start,
          toBlock: end,
        }),
      );
      if (!hash) {
        if (
          await publicClient.readContract({
            address: wallet,
            abi: AgentWalletAbi,
            functionName: "swept",
            args: [sweepId],
          })
        )
          throw new Error(
            "Sweep ID is applied but no matching event was found from starting block",
          );
        return undefined;
      }
      return sweepEvidence(hash, wallet, sweepId);
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
      const fundedEvents = parseEventLogs({
        abi: ECnySimAbi,
        logs: receipt.logs,
        eventName: "Funded",
        strict: false,
      });
      const sweptEvents = parseEventLogs({
        abi: AgentWalletAbi,
        logs: receipt.logs,
        eventName: "Swept",
        strict: false,
      });
      const transferEvents = parseEventLogs({
        abi: ECnySimAbi,
        logs: receipt.logs,
        eventName: "Transfer",
        strict: false,
      });
      return {
        hash,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        transactionIndex: receipt.transactionIndex,
        blockTimestampMs,
        blockTimeIso: new Date(blockTimestampMs).toISOString(),
        transferEvents: transferEvents.map((event) => ({
          token: event.address,
          from: requiredEventArg(event.args.from, "from"),
          to: requiredEventArg(event.args.to, "to"),
          amount: requiredEventArg(event.args.amount, "amount"),
        })),
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
        fundedEvents: fundedEvents.map((event) => ({
          token: event.address,
          fundingId: requiredEventArg(event.args.fundingId, "fundingId"),
          main: requiredEventArg(event.args.main, "main"),
          wallet: requiredEventArg(event.args.wallet, "wallet"),
          amount: requiredEventArg(event.args.amount, "amount"),
        })),
        sweptEvents: sweptEvents.map((event) => ({
          wallet: event.address,
          sweepId: requiredEventArg(event.args.sweepId, "sweepId"),
          main: requiredEventArg(event.args.main, "main"),
          amount: requiredEventArg(event.args.amount, "amount"),
        })),
      };
    },
  };
}
