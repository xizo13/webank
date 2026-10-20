import type { ChainAddresses, FiscoChain } from "@webank/chain";
import { type Address, type Hex, keccak256, stringToHex } from "viem";
import type {
  AuditRecordKind,
  GatewayDependencies,
  Merchant,
  WalletFundingRail,
} from "./types.js";

const auditKinds: Record<AuditRecordKind, number> = {
  pairing: 1,
  mandate: 2,
  payment_decision: 3,
  funding: 4,
  freeze: 5,
  licence_change: 6,
  drill: 7,
  policy_change: 8,
  monitor_alert: 9,
};

export type MerchantClassification = {
  name: string;
  first_seen: boolean;
  honeypot: boolean;
};

/**
 * Bank-controlled policy metadata is required in addition to the on-chain identity.
 * A missing classification fails closed because MerchantRegistry cannot store honeypot status.
 */
export function createFiscoGatewayAdapters(input: {
  chain: FiscoChain;
  addresses: ChainAddresses;
  classifyMerchant(merchantId: string): Promise<MerchantClassification | null>;
}): Pick<
  GatewayDependencies,
  "lookupMerchant" | "preflightPayment" | "executePayment" | "anchorAudit"
> {
  const { chain, addresses } = input;
  return {
    async lookupMerchant(merchantId): Promise<Merchant | null> {
      const classification = await input.classifyMerchant(merchantId);
      if (!classification)
        throw new Error("Merchant policy classification unavailable");
      const record = await chain.getMerchant(
        addresses.merchantRegistry,
        keccak256(stringToHex(merchantId)),
      );
      if (!record.active || /^0x0{40}$/i.test(record.payout)) return null;
      if (!/^0x[0-9a-fA-F]{64}$/.test(record.signingKey))
        throw new Error("Registry merchant signing key is invalid");
      return {
        merchant_id: merchantId,
        name: classification.name,
        legal_name: record.legalName,
        uscc: record.uscc,
        category: record.category,
        first_seen: classification.first_seen,
        honeypot: classification.honeypot,
        public_key: record.signingKey,
        payout: record.payout,
      };
    },
    async executePayment({ paymentId, request, merchant }) {
      const paymentHash = keccak256(stringToHex(paymentId));
      const merchantHash = keccak256(stringToHex(merchant.merchant_id));
      const hash = await chain.pay(
        addresses.agentWallet,
        paymentHash,
        merchantHash,
        BigInt(request.amount.amount),
      );
      const evidence = await chain.getTransactionEvidence(hash);
      if (
        evidence.status !== "success" ||
        !evidence.paidEvents.some(
          (event) =>
            event.paymentId.toLowerCase() === paymentHash.toLowerCase() &&
            event.merchantId.toLowerCase() === merchantHash.toLowerCase() &&
            event.amount === BigInt(request.amount.amount),
        )
      )
        throw new Error("FISCO payment event did not match request");
      return hash;
    },
    async preflightPayment({ paymentId, request, merchant }) {
      await chain.simulatePay(
        addresses.agentWallet,
        keccak256(stringToHex(paymentId)),
        keccak256(stringToHex(merchant.merchant_id)),
        BigInt(request.amount.amount),
      );
    },
    async anchorAudit(recordHash, subjectId, kind) {
      const hashBytes = recordHash.slice("sha256:".length);
      if (!/^[0-9a-fA-F]{64}$/.test(hashBytes))
        throw new Error("Invalid audit hash");
      const subjectHash = keccak256(stringToHex(subjectId));
      const kindCode = auditKinds[kind];
      const hash = await chain.anchor(
        addresses.auditAnchor,
        `0x${hashBytes}` as Hex,
        subjectHash,
        kindCode,
      );
      const evidence = await chain.getTransactionEvidence(hash);
      if (
        evidence.status !== "success" ||
        !evidence.anchoredEvents.some(
          (event) =>
            event.recordHash.toLowerCase() === `0x${hashBytes}`.toLowerCase() &&
            event.subjectId.toLowerCase() === subjectHash.toLowerCase() &&
            event.kind === kindCode,
        )
      )
        throw new Error("FISCO audit event did not match record");
      return hash;
    },
  };
}

/** Read-only Gateway view plus isolated bank-write delegation. */
export function createFiscoFundingRail(input: {
  chain: FiscoChain;
  addresses: ChainAddresses & { bank: Address };
  bankExecutor: {
    fund(fundingId: string, amount: bigint): Promise<Hex>;
    sweep(sweepId: string, amount: bigint): Promise<Hex>;
    payFromMain(confirmationId: string, amount: bigint): Promise<Hex>;
  };
}): WalletFundingRail {
  const { chain, addresses, bankExecutor } = input;
  const fundingHash = (id: string) => keccak256(stringToHex(id));
  const matches = (value: {
    hash: Hex;
    blockNumber: bigint;
    amount: bigint;
    main: Address;
    wallet: Address;
  }) => ({
    hash: value.hash,
    blockNumber: value.blockNumber,
    amount: value.amount,
    main: value.main,
    wallet: value.wallet,
  });
  return {
    deployment: {
      token: addresses.ecnySim,
      main: addresses.bank,
      wallet: addresses.agentWallet,
    },
    snapshot: () =>
      chain.getWalletSnapshot(
        addresses.ecnySim,
        addresses.bank,
        addresses.agentWallet,
      ),
    fund: (id, amount) => bankExecutor.fund(id, amount),
    payFromMain: (id, amount) => bankExecutor.payFromMain(id, amount),
    mainPaymentEvidence: async (hash, payout, amount) => {
      const evidence = await chain.getTransactionEvidence(hash);
      if (evidence.status !== "success")
        throw new Error("Main-account payment reverted");
      const matches = evidence.transferEvents.filter(
        (event) =>
          event.token.toLowerCase() === addresses.ecnySim.toLowerCase() &&
          event.from.toLowerCase() === addresses.bank.toLowerCase() &&
          event.to.toLowerCase() === payout.toLowerCase() &&
          event.amount === amount,
      );
      if (matches.length !== 1)
        throw new Error("Main-account payment evidence did not match");
      return { hash, blockNumber: evidence.blockNumber };
    },
    fundingApplied: (id) =>
      chain.isFundingApplied(addresses.ecnySim, fundingHash(id)),
    fundingEvidence: async (hash, id) =>
      matches(
        await chain.getFundingEvidence(
          hash,
          addresses.ecnySim,
          fundingHash(id),
        ),
      ),
    findFundingEvidence: async (id, fromBlock) => {
      const evidence = await chain.findFundingEvidence(
        addresses.ecnySim,
        fundingHash(id),
        fromBlock,
      );
      return evidence ? matches(evidence) : undefined;
    },
    sweep: (id, amount) => bankExecutor.sweep(id, amount),
    sweepEvidence: async (hash, id) =>
      matches(
        await chain.getSweepEvidence(
          hash,
          addresses.agentWallet,
          fundingHash(id),
        ),
      ),
    findSweepEvidence: async (id, fromBlock) => {
      const evidence = await chain.findSweepEvidence(
        addresses.agentWallet,
        fundingHash(id),
        fromBlock,
      );
      return evidence ? matches(evidence) : undefined;
    },
  };
}
