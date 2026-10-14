import type { ChainAddresses, FiscoChain } from "@webank/chain";
import { type Hex, keccak256, stringToHex } from "viem";
import type {
  AuditRecordKind,
  GatewayDependencies,
  Merchant,
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
  "lookupMerchant" | "executePayment" | "anchorAudit"
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
