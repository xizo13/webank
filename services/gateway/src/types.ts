import type {
  Agent,
  Approval,
  DemoVariant,
  GuardianInput,
  GuardianVerdict,
  Mandate,
  PaymentRequest,
  Policy,
  Receipt,
  RuleDeniedError,
} from "@webank/contracts";
import type { FastifyRequest } from "fastify";

export interface WalletSnapshot {
  mainBalance: bigint;
  walletBalance: bigint;
  walletFrozen: boolean;
  blockNumber: bigint;
  observedAt: string;
}

export interface TransferEvidence {
  hash: `0x${string}`;
  blockNumber: bigint;
  amount: bigint;
  main: `0x${string}`;
  wallet: `0x${string}`;
}

/** Reads chain state; writes are delegated to a bank process outside Gateway. */
export interface WalletFundingRail {
  deployment: {
    token: `0x${string}`;
    main: `0x${string}`;
    wallet: `0x${string}`;
  };
  snapshot(): Promise<WalletSnapshot>;
  fund(fundingId: string, amount: bigint): Promise<`0x${string}`>;
  payFromMain(confirmationId: string, amount: bigint): Promise<`0x${string}`>;
  mainPaymentEvidence(
    hash: `0x${string}`,
    payout: `0x${string}`,
    amount: bigint,
  ): Promise<{ hash: `0x${string}`; blockNumber: bigint }>;
  fundingApplied(fundingId: string): Promise<boolean>;
  fundingEvidence(
    hash: `0x${string}`,
    fundingId: string,
  ): Promise<TransferEvidence>;
  findFundingEvidence(
    fundingId: string,
    fromBlock: bigint,
  ): Promise<TransferEvidence | undefined>;
  sweep(sweepId: string, amount: bigint): Promise<`0x${string}`>;
  sweepEvidence(
    hash: `0x${string}`,
    sweepId: string,
  ): Promise<TransferEvidence>;
  findSweepEvidence(
    sweepId: string,
    fromBlock: bigint,
  ): Promise<TransferEvidence | undefined>;
}

export interface Merchant {
  merchant_id: string;
  name: string;
  legal_name: string;
  uscc: string;
  category: string;
  first_seen: boolean;
  honeypot: boolean;
  /** Raw 32-byte Ed25519 public key as 0x-prefixed hex, from the rail registry. */
  public_key: `0x${string}`;
  /** Registered on-chain payout. Required for a human main-account QR payment. */
  payout?: `0x${string}`;
}

export interface RiskAssessment {
  result: "pass" | "step_up" | "deny";
  signals: { type: string; score: number; action: string }[];
  explanation: string;
}

export interface GatewayDependencies {
  walletFunding?: WalletFundingRail;
  /** Production must provide a bank-backed proof verifier; local demo uses an explicit simulated proof. */
  verifyFundingProof?(
    actionHash: string,
    verification: unknown,
    userId: string,
  ): Promise<boolean>;
  /** Production must verify a registered biometric device key; loopback demo labels its proof simulated. */
  verifyHumanPaymentProof?(
    actionHash: string,
    verification: unknown,
    userId: string,
  ): Promise<boolean>;
  /** Test override only. Live mode uses Gateway's OAuth token and RFC 9421 verifier. */
  authenticateAgent?(request: FastifyRequest): Promise<Agent | null>;
  /** Must verify the WeBank app session. */
  authenticateApp(request: FastifyRequest): Promise<string | null>;
  /** Demo/test proof callback. Never accepted in NODE_ENV=production. */
  demoApprovalVerifier?(
    approval: Approval,
    verification: unknown,
    userId: string,
  ): Promise<"user_biometric" | "demo_simulation" | false>;
  /** Explicit opt-in; tests or WEBANK_DEMO_APPROVALS=1 are also required. */
  demoApprovalsEnabled?: true;
  /** Licence engine assigns points for three wrong zero-trust request numbers. */
  recordNumberMatchFailure(agentId: string, approvalId: string): Promise<void>;
  lookupMerchant(id: string): Promise<Merchant | null>;
  /** Test override; otherwise Gateway uses the fixed local mock variant registry. */
  lookupVariant?(sku: string): Promise<DemoVariant | null>;
  /** Must make an actual hold against available agent-wallet funds. */
  reserveMandate(mandate: Mandate): Promise<boolean>;
  /** Called only after a verified approval or a documented auto-threshold grant. */
  releaseMandate(mandate: Mandate): Promise<void>;
  /** Unknown/unavailable risk assessment must escalate or deny, never pass. */
  assessRisk(input: {
    agent: Agent;
    mandate: Mandate;
    merchant: Merchant;
    paymentRequest: PaymentRequest;
    priceEvidence: unknown[];
  }): Promise<RiskAssessment>;
  evaluateGuardian(input: GuardianInput): Promise<GuardianVerdict>;
  /** Must be idempotent by paymentId at the rail, including retries after process failure. */
  executePayment(input: {
    paymentId: string;
    mandate: Mandate;
    request: PaymentRequest;
    merchant: Merchant;
  }): Promise<`0x${string}`>;
  /** Called only after the rail has verified a matching Paid event. Failure requires reconciliation. */
  notifyMerchantPayment?(input: {
    orderId: string;
    paymentTx: `0x${string}`;
  }): Promise<void>;
  /** Must return a real on-chain anchor transaction hash. */
  anchorAudit(
    recordHash: `sha256:${string}`,
    subjectId: string,
    kind: AuditRecordKind,
  ): Promise<`0x${string}`>;
  /** Signs canonical UTF-8 receipt bytes with the bank's receipt key. */
  signReceipt(bytes: Uint8Array): Promise<string>;
  now?: () => Date;
  approvalTtlSeconds?: number;
  guardianTimeoutMs?: number;
  verificationUriBase?: string;
  /** Exact browser origin allowed to send credentialed demo app requests. */
  appCorsOrigin?: string;
  /** Owner-only local demo snapshot; omitted for ephemeral test instances. */
  statePath?: string;
  /** Deployment identity checked against the restored snapshot. */
  stateContext?: string;
  /** Rebuilds local reservation holds from restored active mandates. */
  restoreReservations?(mandates: Mandate[]): void;
}

export type AuditRecordKind =
  | "pairing"
  | "mandate"
  | "payment_decision"
  | "funding"
  | "freeze"
  | "licence_change"
  | "drill"
  | "policy_change"
  | "monitor_alert";

export interface GatewaySeed {
  agents: Agent[];
  policies: Policy[];
  mandates?: Mandate[];
}

export interface StoredPayment {
  paymentId: string;
  /** Original deployment identity survives an explicit funding cutover. */
  deployment?: string;
  mandateId: string;
  agentId: string;
  userId: string;
  merchant: Merchant;
  request: PaymentRequest;
  decision: import("@webank/contracts").Decision;
  status:
    | "paid"
    | "awaiting_user"
    | "settling"
    | "denied"
    | "reconciliation_required";
  receipt?: Receipt;
  denialError?: RuleDeniedError;
  /** Preserved even if audit or merchant confirmation fails after a verified Paid event. */
  settlementTx?: `0x${string}`;
  approvalId?: string;
  createdAt: string;
}
