import {
  createHash,
  createPublicKey,
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ChainRevertError } from "@webank/chain";
import {
  type Agent,
  AgentSchema,
  type Approval,
  ApprovalDecisionRequestSchema,
  ApprovalSchema,
  type AuditRecord,
  AuditRecordSchema,
  CreateMandateRequestSchema,
  CreateMandateResponseSchema,
  CreatePaymentRequestSchema,
  DecisionSchema,
  type DenialRule,
  DeniedPaymentResponseSchema,
  DeviceAuthorizationRequestSchema,
  DeviceAuthorizationResponseSchema,
  DeviceTokenErrorSchema,
  decodePaymentRequestUri,
  demoVariantBySku,
  GuardianInputSchema,
  GuardianVerdictSchema,
  type Mandate,
  MandateResponseSchema,
  MandateSchema,
  PaidPaymentResponseSchema,
  PaymentHistoryResponseSchema,
  type PaymentRequest,
  type PaymentReview,
  PaymentReviewSchema,
  PaymentStatusResponseSchema,
  PendingMandatePaymentResponseSchema,
  type Policy,
  PolicySchema,
  PositiveMoneySchema,
  type Receipt,
  ReceiptSchema,
  TokenRequestSchema,
  TokenResponseSchema,
  type TrustEvent,
  TrustEventSchema,
} from "@webank/contracts";
import Fastify, { type FastifyRequest } from "fastify";
import { keccak256, stringToHex } from "viem";
import { AgentAuth } from "./agent-auth.js";
import { canonicalJson, sha256, verifyMerchantSignature } from "./crypto.js";
import {
  budgetOf,
  type Check,
  checkMandate,
  checkPolicy,
  mandateIntentLevel,
  type Result,
  strictest,
} from "./decision.js";
import { denial, denialFromChecks } from "./denials.js";
import { DurableState } from "./durable-state.js";
import type {
  GatewayDependencies,
  GatewaySeed,
  Merchant,
  PolicyCapsSnapshot,
  StoredPayment,
  WalletSnapshot,
} from "./types.js";

type Response = { statusCode: number; body: unknown };
type ApprovalEntry = {
  card: Approval;
  userId: string;
  mandateId?: string;
  paymentId?: string;
  requestNumber?: string;
  numberMismatches: number;
};
type PairingEntry = {
  deviceCode: string;
  userCode: string;
  requestNumber: string;
  card: Approval;
  clientName: string;
  provider: string;
  clientAppId?: string;
  clientAppName?: string;
  publicKey: string;
  scopes: Agent["scopes"];
  expiresAt: number;
  status: "pending" | "processing" | "approved" | "denied" | "consumed";
  mismatches: number;
  agentId?: string;
  userId?: string;
  requestNumberExpiresAt: number;
  previousRequestNumber?: string;
  replacementAgentId?: string | null;
  replacementResolved?: boolean;
  ticketAgentId?: string;
  replacementPriorStatus?: Agent["status"];
};
type TrustIntent = {
  intentId: string;
  agentId: string;
  kind: TrustEvent["kind"];
  sourceId: string;
  from: "AMBER" | "GREEN" | "RED";
  level: "AMBER" | "GREEN" | "RED";
  reason: string;
  occurredAt: string;
  status: "pending" | "anchored";
  auditHash?: string;
  evidenceHash?: string;
  forceChain?: boolean;
};
type PolicyLimits = Pick<
  Policy,
  "per_payment_max" | "daily_max" | "monthly_max" | "auto_approve_below"
>;
type PolicyChange = {
  changeId: string;
  userId: string;
  sessionBinding: string;
  policyHash: string;
  baseCaps: { perPayment: number; daily: number; monthly: number };
  baseBlock: string;
  proposed: PolicyLimits;
  actionHash: string;
  expiresAt: number;
  deployment: string;
  status: "prepared" | "applying" | "confirmed";
  auditHash?: string;
  txHash?: `0x${string}`;
};
type AppEvent = {
  id: number;
  type: string;
  data: unknown;
  created_at: string;
};
type FundingRecord = {
  fundingId: string;
  userId: string;
  amount: number;
  status:
    | "prepared"
    | "settling"
    | "completed"
    | "reconciliation_required"
    | "failed";
  deployment: string;
  startingBlock: string;
  txHash?: `0x${string}`;
  blockNumber?: string;
  createdAt: string;
  completedAt?: string;
};
type FundingChallenge = {
  challengeId: string;
  fundingId: string;
  userId: string;
  sessionBinding: string;
  amount: number;
  actionHash: string;
  expiresAt: number;
  consumed: boolean;
};
type SweepRecord = {
  sweepId: string;
  userId: string;
  amount: number;
  status: "settling" | "completed" | "reconciliation_required";
  deployment: string;
  startingBlock: string;
  txHash?: `0x${string}`;
  blockNumber?: string;
  createdAt: string;
  completedAt?: string;
};
type HumanPaymentRecord = {
  confirmationId: string;
  challengeId: string;
  userId: string;
  sessionBinding: string;
  merchantId: string;
  merchantLegalName: string;
  merchantUscc: string;
  merchantPublicKey: `0x${string}`;
  payout: `0x${string}`;
  orderId: string;
  nonceKey: string;
  paymentRequestHash: string;
  paymentRequestExpiresAt: number;
  amount: number;
  actionHash: string;
  expiresAt: number;
  consumed: boolean;
  status:
    | "prepared"
    | "settling"
    | "completed"
    | "reconciliation_required"
    | "failed";
  deployment: string;
  startingBlock: string;
  txHash?: `0x${string}`;
  blockNumber?: string;
  shopNotified?: boolean;
  createdAt: string;
  completedAt?: string;
};
type IdleChallenge = {
  challengeId: string;
  userId: string;
  agentId: string;
  actionHash: string;
  sessionBinding: string;
  challenge: string;
  expiresAt: number;
  used: boolean;
};
type IdleRenewal = {
  agentId: string;
  publicKey: string;
  expiresAt: number;
  consumed: boolean;
};
type GatewayState = {
  context: string;
  trustEvents?: TrustEvent[];
  trustPending?: TrustIntent[];
  activeDrill?: { drillId: string; startedAt: string } | null;
  riskAttempts?: Array<{
    agentId: string;
    merchantId: string;
    orderId: string;
    at: string;
  }>;
  riskHistoryKnownAgents?: string[];
  agents: Agent[];
  policies: ReturnType<typeof PolicySchema.parse>[];
  mandates: ReturnType<typeof MandateSchema.parse>[];
  approvals: Array<[string, ApprovalEntry]>;
  pairings: PairingEntry[];
  /** Agent spending fences held while owner-approved replacement releases mandates. */
  replacingAgents?: string[];
  replacementTickets: Array<
    [
      string,
      { agentId: string; expiresAt: number; priorStatus: Agent["status"] },
    ]
  >;
  actionChallenges: Array<
    [
      string,
      {
        userId: string;
        agentId: string;
        action:
          | "unfreeze"
          | "relicense"
          | "return_to_amber"
          | "demo_fast_forward_green";
        actionHash: string;
        sessionBinding: string;
        challenge: string;
        expiresAt: number;
        used: boolean;
      },
    ]
  >;
  idleChallenges?: IdleChallenge[];
  idleRenewals?: IdleRenewal[];
  payments: StoredPayment[];
  usedMerchantNonces: string[];
  audits: AuditRecord[];
  eventsByUser: Array<[string, AppEvent[]]>;
  idempotency: Array<
    [
      string,
      { bodyHash: string; response: Response | null; paymentId?: string },
    ]
  >;
  fundingRecords?: FundingRecord[];
  fundingChallenges?: FundingChallenge[];
  fundingKeys?: Array<[string, { bodyHash: string; fundingId: string }]>;
  sweepRecords?: SweepRecord[];
  sweepKeys?: Array<[string, { bodyHash: string; sweepId: string }]>;
  humanPaymentRecords?: HumanPaymentRecord[];
  humanPaymentKeys?: Array<
    [string, { bodyHash: string; confirmationId: string }]
  >;
  policyChanges?: PolicyChange[];
  policyKeys?: Array<[string, { bodyHash: string; changeId: string }]>;
  auth: ReturnType<AgentAuth["snapshot"]>;
};

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const IDLE_LIMIT_MS = 7 * 86_400_000;
const IDLE_RENEWAL_MS = 10 * 60_000;
const error = (
  code: string,
  statusCode: number,
  decisionId?: string,
): Response => ({
  statusCode,
  body: { error: { code, ...(decisionId ? { decision_id: decisionId } : {}) } },
});
const agentDenied = (
  rule: Parameters<typeof denial>[0],
  detail: Record<string, unknown> = {},
): Response => ({ statusCode: 403, body: { error: denial(rule, detail) } });

/** Gateway vertical slice. Inject real authentication, funds, chain and signing adapters. */
export function createGateway(deps: GatewayDependencies, seed: GatewaySeed) {
  if (process.env.NODE_ENV === "production" && deps.demoApprovalsEnabled)
    throw new Error("Demo approval proofs are forbidden in production");
  const app = Fastify({
    logger: process.env.WEBANK_LOCAL_DEMO === "1" ? { level: "error" } : false,
  });
  if (deps.appCorsOrigin) {
    const allowedOrigin = new URL(deps.appCorsOrigin).origin;
    app.addHook("onRequest", async (request, reply) => {
      if (request.headers.origin === allowedOrigin) {
        reply.header("Access-Control-Allow-Origin", allowedOrigin);
        reply.header("Access-Control-Allow-Credentials", "true");
        reply.header(
          "Access-Control-Allow-Headers",
          "Content-Type, Idempotency-Key, Authorization",
        );
        reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
        reply.header("Vary", "Origin");
      }
    });
    app.options("/*", async (_request, reply) => reply.code(204).send());
  }
  const rawBodies = new WeakMap<FastifyRequest, Buffer>();
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      rawBodies.set(request, bytes);
      try {
        done(null, JSON.parse(bytes.toString("utf8")));
      } catch (failure) {
        done(failure as Error);
      }
    },
  );
  const agentAuth = new AgentAuth();
  const now = deps.now ?? (() => new Date());
  const demoProofAvailable =
    deps.demoApprovalsEnabled === true &&
    typeof deps.demoApprovalVerifier === "function" &&
    (process.env.NODE_ENV === "test" ||
      process.env.WEBANK_DEMO_APPROVALS === "1");
  async function verifyDemoProof(
    approval: Approval,
    proof: unknown,
    userId: string,
  ) {
    if (!demoProofAvailable || !deps.demoApprovalVerifier) return false;
    return deps.demoApprovalVerifier(approval, proof, userId);
  }
  const ttl = deps.approvalTtlSeconds ?? 180;
  const guardianTimeoutMs = deps.guardianTimeoutMs ?? 8000;
  if (!Number.isInteger(ttl) || ttl <= 0)
    throw new Error("Invalid approval TTL");
  const agents = new Map(
    seed.agents.map((value) => {
      const agent = AgentSchema.parse(value);
      return [agent.agent_id, agent] as const;
    }),
  );
  const policies = new Map(
    seed.policies.map((value) => {
      const policy = PolicySchema.parse(value);
      return [policy.user_id, policy] as const;
    }),
  );
  const mandates = new Map(
    (seed.mandates ?? []).map((value) => {
      const mandate = MandateSchema.parse(value);
      return [mandate.mandate_id, mandate] as const;
    }),
  );
  const approvals = new Map<string, ApprovalEntry>();
  const pairingByDevice = new Map<string, PairingEntry>();
  const pairingByUserCode = new Map<string, PairingEntry>();
  const replacementTickets = new Map<
    string,
    { agentId: string; expiresAt: number; priorStatus: Agent["status"] }
  >();
  const actionChallenges = new Map<
    string,
    {
      userId: string;
      agentId: string;
      action:
        | "unfreeze"
        | "relicense"
        | "return_to_amber"
        | "demo_fast_forward_green";
      actionHash: string;
      sessionBinding: string;
      challenge: string;
      expiresAt: number;
      used: boolean;
    }
  >();
  const idleChallenges = new Map<string, IdleChallenge>();
  const idleRenewals = new Map<string, IdleRenewal>();
  const payments = new Map<string, StoredPayment>();
  async function spentInPolicyWindows(userId: string) {
    if (deps.policyCaps) {
      const observed = await deps.policyCaps.read();
      return {
        spentToday: safeFen(observed.spentToday),
        spentMonth: safeFen(observed.spentMonth),
      };
    }
    const today = now().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    let spentToday = 0;
    let spentMonth = 0;
    for (const payment of payments.values()) {
      if (payment.userId !== userId || payment.status !== "paid") continue;
      const settledAt = payment.paidAt ?? payment.createdAt;
      if (settledAt.slice(0, 7) === month)
        spentMonth += payment.request.amount.amount;
      if (settledAt.slice(0, 10) === today)
        spentToday += payment.request.amount.amount;
    }
    return { spentToday, spentMonth };
  }
  const fundingRecords = new Map<string, FundingRecord>();
  const fundingChallenges = new Map<string, FundingChallenge>();
  const fundingKeys = new Map<
    string,
    { bodyHash: string; fundingId: string }
  >();
  const sweepRecords = new Map<string, SweepRecord>();
  const sweepKeys = new Map<string, { bodyHash: string; sweepId: string }>();
  const humanPaymentRecords = new Map<string, HumanPaymentRecord>();
  const humanPaymentKeys = new Map<
    string,
    { bodyHash: string; confirmationId: string }
  >();
  const policyChanges = new Map<string, PolicyChange>();
  const policyKeys = new Map<string, { bodyHash: string; changeId: string }>();
  const replacingAgents = new Set<string>();
  const usedMerchantNonces = new Set<string>();
  const audits: AuditRecord[] = [];
  const trustEvents: TrustEvent[] = [];
  const trustPending = new Map<string, TrustIntent>();
  let activeDrill: { drillId: string; startedAt: string } | null = null;
  const riskAttempts: Array<{
    agentId: string;
    merchantId: string;
    orderId: string;
    at: string;
  }> = [];
  const riskHistoryKnownAgents = new Set<string>(
    deps.statePath ? [] : [...agents.keys()],
  );
  const eventsByUser = new Map<string, AppEvent[]>();
  const idempotency = new Map<
    string,
    {
      bodyHash: string;
      result: Promise<Response>;
      response?: Response;
      paymentId?: string;
    }
  >();
  const paymentSubmissionTails = new Map<string, Promise<void>>();
  let recoveredIntents = false;
  let restoredFromDisk = false;
  const stateStore = deps.statePath
    ? new DurableState<GatewayState>(deps.statePath)
    : null;
  try {
    const restored = stateStore?.load();
    if (restored) {
      restoredFromDisk = true;
      if (restored.context !== (deps.stateContext ?? "test"))
        throw new Error("Gateway state belongs to another deployment");
      if (
        !Array.isArray(restored.agents) ||
        !Array.isArray(restored.policies) ||
        !Array.isArray(restored.mandates) ||
        !Array.isArray(restored.approvals) ||
        !Array.isArray(restored.pairings) ||
        (restored.replacingAgents !== undefined &&
          !Array.isArray(restored.replacingAgents)) ||
        !Array.isArray(restored.payments) ||
        !Array.isArray(restored.usedMerchantNonces) ||
        !Array.isArray(restored.audits) ||
        !Array.isArray(restored.eventsByUser) ||
        !Array.isArray(restored.idempotency) ||
        !Array.isArray(restored.replacementTickets) ||
        !Array.isArray(restored.actionChallenges) ||
        (restored.idleChallenges !== undefined &&
          !Array.isArray(restored.idleChallenges)) ||
        (restored.idleRenewals !== undefined &&
          !Array.isArray(restored.idleRenewals)) ||
        !restored.auth ||
        !Array.isArray(restored.auth.access) ||
        !Array.isArray(restored.auth.refresh) ||
        !Array.isArray(restored.auth.nonces)
      )
        throw new Error("Gateway state payload is incompatible");
      agents.clear();
      for (const value of restored.agents) {
        const item = AgentSchema.parse(value);
        agents.set(item.agent_id, item);
      }
      policies.clear();
      for (const value of restored.policies) {
        const item = PolicySchema.parse(value);
        policies.set(item.user_id, item);
      }
      mandates.clear();
      for (const value of restored.mandates) {
        const item = MandateSchema.parse(value);
        mandates.set(item.mandate_id, item);
      }
      for (const [key, value] of restored.approvals)
        approvals.set(key, {
          ...value,
          card: ApprovalSchema.parse(value.card),
        });
      for (const value of restored.pairings) {
        const item = { ...value, card: ApprovalSchema.parse(value.card) };
        if (item.status === "processing" && !item.agentId)
          item.status = "pending";
        if (item.status === "pending") ensureIndependentPairing(item);
        pairingByDevice.set(item.deviceCode, item);
        pairingByUserCode.set(item.userCode, item);
      }
      for (const agentId of restored.replacingAgents ?? []) {
        if (typeof agentId !== "string" || !agents.has(agentId))
          throw new Error("Gateway replacement fence is incompatible");
        replacingAgents.add(agentId);
      }
      for (const [key, value] of restored.replacementTickets)
        replacementTickets.set(key, value);
      for (const [key, value] of restored.actionChallenges)
        actionChallenges.set(key, value);
      for (const value of restored.idleChallenges ?? [])
        idleChallenges.set(value.challengeId, value);
      for (const value of restored.idleRenewals ?? [])
        idleRenewals.set(value.agentId, value);
      for (const value of restored.payments) {
        if (
          !value ||
          typeof value.paymentId !== "string" ||
          typeof value.mandateId !== "string"
        )
          throw new Error("Gateway payment state is incompatible");
        payments.set(value.paymentId, value);
      }
      for (const value of restored.fundingRecords ?? []) {
        if (value.status === "settling") {
          value.status = "reconciliation_required";
          recoveredIntents = true;
        }
        fundingRecords.set(value.fundingId, value);
      }
      for (const value of restored.fundingChallenges ?? [])
        fundingChallenges.set(value.challengeId, value);
      for (const [key, value] of restored.fundingKeys ?? [])
        fundingKeys.set(key, value);
      for (const value of restored.sweepRecords ?? []) {
        if (value.status === "settling") {
          value.status = "reconciliation_required";
          recoveredIntents = true;
        }
        sweepRecords.set(value.sweepId, value);
      }
      for (const [key, value] of restored.sweepKeys ?? [])
        sweepKeys.set(key, value);
      for (const value of restored.humanPaymentRecords ?? []) {
        if (value.status === "settling") {
          value.status = "reconciliation_required";
          recoveredIntents = true;
        }
        humanPaymentRecords.set(value.confirmationId, value);
      }
      for (const [key, value] of restored.humanPaymentKeys ?? [])
        humanPaymentKeys.set(key, value);
      for (const value of restored.policyChanges ?? []) {
        if (!policies.has(value.userId) || policyChanges.has(value.changeId))
          throw new Error("Policy change state is incompatible");
        policyChanges.set(value.changeId, value);
      }
      for (const [key, value] of restored.policyKeys ?? [])
        policyKeys.set(key, value);
      for (const value of restored.usedMerchantNonces)
        usedMerchantNonces.add(value);
      for (const value of restored.audits)
        audits.push(AuditRecordSchema.parse(value));
      for (const value of restored.trustEvents ?? [])
        trustEvents.push(TrustEventSchema.parse(value));
      for (const value of restored.trustPending ?? []) {
        if (!agents.has(value.agentId))
          throw new Error("Unknown trust intent agent");
        trustPending.set(value.agentId, value);
      }
      activeDrill = restored.activeDrill ?? null;
      for (const attempt of restored.riskAttempts ?? []) {
        if (
          typeof attempt.agentId !== "string" ||
          typeof attempt.merchantId !== "string" ||
          typeof attempt.orderId !== "string" ||
          !Number.isFinite(Date.parse(attempt.at))
        )
          throw new Error("Risk attempt history is incompatible");
        riskAttempts.push(attempt);
      }
      for (const agentId of restored.riskHistoryKnownAgents ?? []) {
        if (!agents.has(agentId))
          throw new Error("Risk history agent is incompatible");
        riskHistoryKnownAgents.add(agentId);
      }
      for (const [key, value] of restored.eventsByUser)
        eventsByUser.set(key, value);
      for (const [key, value] of restored.idempotency) {
        const payment = value.paymentId
          ? payments.get(value.paymentId)
          : undefined;
        const response =
          value.response ??
          (payment
            ? reconciliationError(payment)
            : error("policy_denied", 503));
        idempotency.set(key, {
          bodyHash: value.bodyHash,
          result: Promise.resolve(response),
          response,
          paymentId: value.paymentId,
        });
      }
      agentAuth.restore(restored.auth);
      for (const payment of payments.values()) {
        if (payment.status === "settling") {
          payment.status = "reconciliation_required";
          const events = eventsByUser.get(payment.userId) ?? [];
          events.push({
            id: events.length + 1,
            type: "payment.reconciliation_required",
            data: {
              payment_id: payment.paymentId,
              ...(payment.settlementTx
                ? { payment_tx: payment.settlementTx }
                : {}),
            },
            created_at: now().toISOString(),
          });
          eventsByUser.set(payment.userId, events);
          recoveredIntents = true;
        }
      }
      deps.restoreReservations?.([...mandates.values()]);
    }
  } catch (failure) {
    stateStore?.close();
    throw failure;
  }
  for (const agent of agents.values()) {
    if (
      agent.legacy_red_evidence &&
      agent.legacy_red_evidence.audit_ids === undefined
    )
      agent.legacy_red_evidence.audit_ids = audits
        .filter((item) => item.subject_id === agent.agent_id)
        .map((item) => item.audit_id);
  }
  function snapshot(): GatewayState {
    return {
      context: deps.stateContext ?? "test",
      trustEvents,
      trustPending: [...trustPending.values()],
      activeDrill,
      riskAttempts,
      riskHistoryKnownAgents: [...riskHistoryKnownAgents],
      agents: [...agents.values()],
      policies: [...policies.values()],
      mandates: [...mandates.values()],
      approvals: [...approvals],
      pairings: [...pairingByDevice.values()],
      replacingAgents: [...replacingAgents],
      replacementTickets: [...replacementTickets],
      actionChallenges: [...actionChallenges],
      idleChallenges: [...idleChallenges.values()],
      idleRenewals: [...idleRenewals.values()],
      payments: [...payments.values()],
      usedMerchantNonces: [...usedMerchantNonces],
      audits,
      eventsByUser: [...eventsByUser],
      idempotency: [...idempotency].map(([key, value]) => [
        key,
        {
          bodyHash: value.bodyHash,
          response: value.response ?? null,
          ...(value.paymentId ? { paymentId: value.paymentId } : {}),
        },
      ]),
      fundingRecords: [...fundingRecords.values()],
      fundingChallenges: [...fundingChallenges.values()],
      fundingKeys: [...fundingKeys],
      sweepRecords: [...sweepRecords.values()],
      sweepKeys: [...sweepKeys],
      humanPaymentRecords: [...humanPaymentRecords.values()],
      humanPaymentKeys: [...humanPaymentKeys],
      policyChanges: [...policyChanges.values()],
      policyKeys: [...policyKeys],
      auth: agentAuth.snapshot(),
    };
  }
  function persist(): void {
    stateStore?.save(snapshot());
  }
  if (stateStore && (!restoredFromDisk || recoveredIntents)) {
    try {
      persist();
    } catch (failure) {
      stateStore?.close();
      throw failure;
    }
  }
  if (stateStore) {
    app.addHook("onSend", async (_request, _reply, payload) => {
      persist();
      return payload;
    });
  }
  const expiryTimers = new Set<ReturnType<typeof setTimeout>>();
  app.addHook("onClose", async () => {
    for (const timer of expiryTimers) clearTimeout(timer);
    expiryTimers.clear();
    stateStore?.close();
  });
  app.addHook("onReady", async () => {
    for (const change of policyChanges.values()) {
      if (change.status !== "applying") continue;
      try {
        await finishPolicyChange(change);
      } catch (failure) {
        app.log.error(
          { failure, changeId: change.changeId },
          "Policy change remains fenced",
        );
      }
    }
    for (const pending of trustPending.values()) {
      const agent = agents.get(pending.agentId);
      if (!agent) throw new Error("Trust intent references an unknown agent");
      try {
        await finishTrustIntent(agent, pending);
      } catch (failure) {
        app.log.error(
          { failure, agentId: agent.agent_id },
          "Trust transition remains fenced for reconciliation",
        );
      }
    }
    for (const pairing of pairingByDevice.values()) {
      if (pairing.status !== "processing" || !pairing.agentId) continue;
      const agent = agents.get(pairing.agentId);
      if (!agent) continue;
      try {
        await recordTrustEvent(
          agent,
          "transition",
          `initial-amber:${pairing.deviceCode}`,
          "New paired agent registered Amber",
          "AMBER",
          true,
        );
        agent.status = "active";
        riskHistoryKnownAgents.add(agent.agent_id);
        pairing.status = "approved";
        pairing.card.status = "approved";
        persist();
      } catch (failure) {
        app.log.error(
          { failure, agentId: agent.agent_id },
          "Initial Amber registry write requires reconciliation",
        );
      }
    }
    for (const payment of payments.values()) {
      if (
        payment.status !== "paid" ||
        payment.approvalSource !== "owner" ||
        !payment.approvalId ||
        !payment.paidAt
      )
        continue;
      if (
        trustEvents.some(
          (item) =>
            item.kind === "clean_purchase" &&
            item.source_id === payment.paymentId,
        )
      )
        continue;
      const agent = agents.get(payment.agentId);
      if (!agent || trustPending.has(agent.agent_id)) continue;
      const amberEntry = trustEvents[latestAmberEntryIndex(agent.agent_id)];
      if (
        amberEntry &&
        Date.parse(payment.paidAt) <=
          Date.parse(amberEntry.confirmed_at ?? amberEntry.occurred_at)
      )
        continue;
      try {
        await recordTrustEvent(
          agent,
          "clean_purchase",
          payment.paymentId,
          "Owner-approved paid purchase verified",
          undefined,
          false,
          undefined,
          payment.paidAt,
        );
      } catch (failure) {
        app.log.error(
          { failure, paymentId: payment.paymentId },
          "Paid purchase trust evidence requires reconciliation",
        );
      }
    }
    for (const agent of agents.values()) {
      if (agent.licence.level !== "AMBER" || trustPending.has(agent.agent_id))
        continue;
      try {
        await maybePromoteAmber(agent);
      } catch (failure) {
        app.log.error(
          { failure, agentId: agent.agent_id },
          "Amber qualification requires reconciliation",
        );
      }
    }
    if (deps.setDrillVisibility)
      await deps.setDrillVisibility(activeDrill !== null);
    for (const mandate of mandates.values()) {
      if (
        mandate.status !== "active" &&
        mandate.status !== "pending_user" &&
        mandate.status !== "pending_checkout"
      )
        continue;
      const owner = agents.get(mandate.agent_id);
      if (!owner) throw new Error("Gateway mandate references a missing agent");
      if (owner.status !== "revoked" && !owner.deleted_at) continue;
      // An uncertain payment keeps its hold until the rail is reconciled.
      if (mandate.in_flight_payment_id !== null) continue;
      if (mandate.status === "active") await deps.releaseMandate(mandate);
      mandate.status = "cancelled";
      for (const entry of approvals.values()) {
        if (
          entry.mandateId === mandate.mandate_id &&
          entry.card.status === "pending"
        )
          entry.card.status = "rejected";
      }
      emitEvent(owner.user_id, "mandate.cancelled", {
        mandate_id: mandate.mandate_id,
        reason: "revoked_agent_recovery",
      });
      persist();
    }
  });

  function emitEvent(userId: string, type: string, data: unknown): void {
    const events = eventsByUser.get(userId) ?? [];
    events.push({
      id: events.length + 1,
      type,
      data: structuredClone(data),
      created_at: now().toISOString(),
    });
    eventsByUser.set(userId, events);
  }

  async function cancelRevokedAgentMandates(
    agent: Agent,
    reason: string,
  ): Promise<boolean> {
    persist();
    const cancel = (mandate: Mandate) => {
      mandate.status = "cancelled";
      for (const entry of approvals.values()) {
        if (
          entry.mandateId === mandate.mandate_id &&
          entry.card.status === "pending"
        ) {
          entry.card.status = "rejected";
          emitEvent(agent.user_id, "approval.resolved", {
            approval_id: entry.card.approval_id,
            status: "rejected",
          });
        }
      }
      emitEvent(agent.user_id, "mandate.cancelled", {
        mandate_id: mandate.mandate_id,
        reason,
      });
    };
    for (const mandate of mandates.values()) {
      if (
        mandate.agent_id === agent.agent_id &&
        (mandate.status === "pending_user" ||
          (mandate.status === "pending_checkout" &&
            mandate.in_flight_payment_id === null))
      )
        cancel(mandate);
    }
    for (const entry of approvals.values()) {
      const payment = entry.paymentId ? payments.get(entry.paymentId) : null;
      if (
        payment?.agentId === agent.agent_id &&
        entry.card.status === "pending"
      ) {
        entry.card.status = "rejected";
        emitEvent(agent.user_id, "approval.resolved", {
          approval_id: entry.card.approval_id,
          status: "rejected",
        });
      }
    }
    for (const payment of payments.values()) {
      if (
        payment.agentId !== agent.agent_id ||
        payment.status !== "awaiting_user"
      )
        continue;
      const response = await settle(
        payment,
        "DENIED",
        "The agent's access was revoked before approval.",
      );
      if (response.statusCode >= 500) return false;
    }
    const outstanding = [...mandates.values()].filter(
      (mandate) =>
        mandate.agent_id === agent.agent_id && mandate.status === "active",
    );
    try {
      for (const mandate of outstanding) {
        if (mandate.status === "active" && !mandate.in_flight_payment_id)
          await deps.releaseMandate(mandate);
      }
    } catch {
      return false;
    }
    for (const mandate of outstanding) {
      if (mandate.in_flight_payment_id) continue;
      cancel(mandate);
    }
    return true;
  }

  async function retireRedAgentAuthority(agent: Agent): Promise<boolean> {
    for (const payment of payments.values()) {
      if (
        payment.agentId !== agent.agent_id ||
        payment.status !== "awaiting_user"
      )
        continue;
      const response = await settle(
        payment,
        "DENIED",
        "The agent turned Red before this payment was approved.",
      );
      if (response.statusCode >= 500) return false;
    }
    for (const mandate of mandates.values()) {
      if (mandate.agent_id !== agent.agent_id) continue;
      if (
        mandate.status !== "active" &&
        mandate.status !== "pending_user" &&
        mandate.status !== "pending_checkout"
      )
        continue;
      if (mandate.status === "active" && !mandate.in_flight_payment_id) {
        try {
          await deps.releaseMandate(mandate);
        } catch {
          return false;
        }
      }
      mandate.status = "cancelled";
      emitEvent(agent.user_id, "mandate.cancelled", {
        mandate_id: mandate.mandate_id,
        reason: "trust_red",
      });
    }
    for (const entry of approvals.values()) {
      const ownedMandate = entry.mandateId
        ? mandates.get(entry.mandateId)
        : undefined;
      const ownedPayment = entry.paymentId
        ? payments.get(entry.paymentId)
        : undefined;
      if (
        entry.card.status !== "pending" ||
        (ownedMandate?.agent_id !== agent.agent_id &&
          ownedPayment?.agentId !== agent.agent_id)
      )
        continue;
      entry.card.status = "rejected";
      emitEvent(agent.user_id, "approval.resolved", {
        approval_id: entry.card.approval_id,
        status: "rejected",
      });
    }
    persist();
    return true;
  }

  function pairingStatus(pairing: PairingEntry) {
    if (pairing.status === "approved" || pairing.status === "consumed")
      return "approved";
    if (pairing.status === "denied") return "rejected";
    if (pairing.expiresAt <= now().getTime()) return "expired";
    return "pending";
  }

  function rotatePairingNumber(pairing: PairingEntry) {
    if (pairingStatus(pairing) !== "pending") return;
    if (pairing.requestNumberExpiresAt > now().getTime()) return;
    pairing.previousRequestNumber = pairing.requestNumber;
    do {
      pairing.requestNumber = randomInt(0, 1_000_000)
        .toString()
        .padStart(6, "0");
    } while (pairing.requestNumber === pairing.previousRequestNumber);
    pairing.requestNumberExpiresAt = Math.min(
      now().getTime() + 180_000,
      pairing.expiresAt,
    );
  }

  function replacementSummary(agent: Agent) {
    return {
      agent_id: agent.agent_id,
      display_name: agent.display_name,
      provider: agent.provider,
      prior_status: agent.status,
      prior_licence_level: agent.licence.level,
      points: agent.licence.legacy_points ?? 0,
      demerit_count: agent.licence.flags_30d,
      latest_reason:
        audits.filter((item) => item.subject_id === agent.agent_id).at(-1)
          ?.summary ?? null,
      root_agent_id: agent.lineage?.root_agent_id ?? agent.agent_id,
      deleted_at: agent.deleted_at ?? null,
    };
  }

  function trustActionSummary(agent: Agent) {
    return {
      agent_id: agent.agent_id,
      display_name: agent.display_name,
      client_app_id: agent.client_app_id ?? null,
      client_app_name: agent.client_app_name ?? null,
      public_key_preview: `${agent.public_key.slice(0, 20)}...`,
      scopes: agent.scopes,
      level: agent.licence.level,
      flags_30d: flagsInWindow(agent.agent_id),
      drills_failed: agent.licence.drills_failed,
      reason: agent.licence.reason,
      latest_evidence_ids: trustEvents
        .filter((item) => item.agent_id === agent.agent_id)
        .slice(-10)
        .map((item) => item.event_id),
      legacy_evidence: agent.legacy_red_evidence ?? null,
    };
  }

  function trustResetActionHash(
    agent: Agent,
    userId: string,
    sessionBinding: string,
    challengeId: string,
    expiresAt: number,
  ): string {
    return sha256({
      schema: "trust_reset.v1",
      user_id: userId,
      agent_id: agent.agent_id,
      key_hash: keccak256(stringToHex(agent.public_key)),
      expected_level: "RED",
      flags_30d: flagsInWindow(agent.agent_id),
      evidence: trustEvents
        .filter(
          (event) =>
            event.agent_id === agent.agent_id &&
            event.kind !== "clean_purchase",
        )
        .map((event) => ({
          event_id: event.event_id,
          kind: event.kind,
          source_id: event.source_id,
          audit_hash: event.audit_hash,
          ...(event.confirmed_at ? { confirmed_at: event.confirmed_at } : {}),
          ...(event.evidence_hash
            ? { evidence_hash: event.evidence_hash }
            : {}),
        })),
      legacy_evidence: trustActionSummary(agent).legacy_evidence,
      session_binding: sessionBinding,
      challenge_id: challengeId,
      expires_at: new Date(expiresAt).toISOString(),
    });
  }

  function pairingSummary(pairing: PairingEntry) {
    const prior = pairing.replacementAgentId
      ? agents.get(pairing.replacementAgentId)
      : null;
    return {
      schema: "pairing.v1",
      user_code: pairing.userCode,
      client_name: pairing.clientName,
      provider: pairing.provider,
      client_app_id: pairing.clientAppId ?? null,
      client_app_name: pairing.clientAppName ?? null,
      requested_scopes: pairing.scopes,
      status: pairingStatus(pairing),
      agent_id: pairing.agentId ?? null,
      expires_at: new Date(pairing.expiresAt).toISOString(),
      request_number_expires_at:
        pairingStatus(pairing) === "pending"
          ? new Date(pairing.requestNumberExpiresAt).toISOString()
          : null,
      replacement: prior
        ? {
            ...replacementSummary(prior),
            ...(pairing.replacementPriorStatus
              ? { status_before_revoke: pairing.replacementPriorStatus }
              : {}),
          }
        : null,
    };
  }

  function ensureIndependentPairing(pairing: PairingEntry): void {
    if (
      pairing.replacementResolved === true &&
      !pairing.replacementAgentId &&
      !pairing.ticketAgentId
    )
      return;
    pairing.replacementAgentId = null;
    pairing.replacementResolved = true;
    pairing.ticketAgentId = undefined;
    pairing.replacementPriorStatus = undefined;
    pairing.card.lines = [
      `Agent request: ${pairing.clientName}`,
      `Provider claim: ${pairing.provider}`,
      `Client app: ${pairing.clientAppName ?? "Unidentified legacy client"}`,
      `Client app ID: ${pairing.clientAppId ?? "unidentified"}`,
      `Requested scopes: ${pairing.scopes.join(", ")}`,
      `Public key: ${pairing.publicKey}`,
    ];
    // A pending legacy consent must acquire a new hash before it can approve
    // an independent identity. A prior lineage choice cannot carry over.
    pairing.card.payload_hash = sha256({
      schema: "pairing_consent.v2",
      userCode: pairing.userCode,
      publicKey: pairing.publicKey,
      lines: pairing.card.lines,
    });
  }

  function idleExpiresAt(agent: Agent): string {
    return new Date(
      Date.parse(agent.last_used_at ?? agent.created_at) + IDLE_LIMIT_MS,
    ).toISOString();
  }

  function idleRequired(agent: Agent): boolean {
    return now().getTime() >= Date.parse(idleExpiresAt(agent));
  }

  function agentWithIdleState(agent: Agent) {
    return {
      ...agent,
      client_app_id: agent.client_app_id ?? null,
      client_app_name: agent.client_app_name ?? null,
      idle_expires_at: idleExpiresAt(agent),
      reauthorization_required:
        agent.status === "active" &&
        agent.licence.level !== "RED" &&
        idleRequired(agent),
    };
  }

  function invalidateIdleRecovery(agentId: string): void {
    idleRenewals.delete(agentId);
    for (const challenge of idleChallenges.values()) {
      if (challenge.agentId === agentId) challenge.used = true;
    }
  }

  async function agentFor(
    request: FastifyRequest,
    scope: Agent["scopes"][number],
  ) {
    let authenticated: Agent | null;
    try {
      if (deps.authenticateAgent) {
        authenticated = await deps.authenticateAgent(request);
      } else {
        const result = agentAuth.verify(
          request,
          rawBodies.get(request) ?? Buffer.alloc(0),
          agents,
          now().getTime(),
          true,
        );
        if ("error" in result) return { response: error(result.error, 401) };
        authenticated = result.agent;
      }
    } catch {
      return { response: error("bad_signature", 401) };
    }
    if (!authenticated) return { response: error("bad_signature", 401) };
    const registered = agents.get(authenticated.agent_id);
    if (!registered || registered.public_key !== authenticated.public_key)
      return { response: error("bad_signature", 401) };
    if (
      registered.status !== "active" ||
      registered.deleted_at ||
      registered.licence.level === "RED" ||
      trustPending.has(registered.agent_id) ||
      replacingAgents.has(registered.agent_id)
    )
      return { response: error("agent_frozen", 401) };
    if (idleRequired(registered))
      return { response: error("reauthorization_required", 401) };
    if (!deps.authenticateAgent) {
      const token = request.headers.authorization?.match(
        /^Bearer ([A-Za-z0-9_-]+)$/,
      )?.[1];
      const status = agentAuth.accessStatus(
        token,
        registered.agent_id,
        now().getTime(),
      );
      if (status !== "valid")
        return {
          response: error(
            status === "expired" ? "token_expired" : "bad_signature",
            401,
          ),
        };
    }
    if (!registered.scopes.includes(scope))
      return { response: agentDenied("scope_missing", { scope }) };
    return { agent: registered };
  }

  async function appUser(request: FastifyRequest) {
    try {
      return await deps.authenticateApp(request);
    } catch {
      return null;
    }
  }

  function appSessionBinding(request: FastifyRequest): string {
    return sha256(
      request.headers.cookie ?? request.headers.authorization ?? "",
    );
  }

  async function idem(
    actor: string,
    request: FastifyRequest,
    run: () => Promise<Response>,
  ): Promise<Response> {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 1 || key.length > 255)
      return error("idempotency_conflict", 409);
    const mapKey = `${actor}:${request.method}:${request.url}:${key}`;
    const bodyHash = sha256(request.body ?? null);
    const existing = idempotency.get(mapKey);
    if (existing)
      return existing.bodyHash === bodyHash
        ? existing.result
        : error("idempotency_conflict", 409);
    const entry: {
      bodyHash: string;
      result: Promise<Response>;
      response?: Response;
      paymentId?: string;
    } = {
      bodyHash,
      result: Promise.resolve(error("reconciliation_required", 503)),
    };
    const result = Promise.resolve()
      .then(run)
      .catch(() => error("policy_denied", 503))
      .then((response) => {
        entry.response = response;
        return response;
      });
    entry.result = result;
    idempotency.set(mapKey, entry);
    return result;
  }

  async function serializePaymentSubmission<T>(
    userId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const prior = paymentSubmissionTails.get(userId);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    paymentSubmissionTails.set(userId, current);
    if (prior) await prior;
    try {
      return await run();
    } finally {
      release();
      if (paymentSubmissionTails.get(userId) === current)
        paymentSubmissionTails.delete(userId);
    }
  }

  const walletMoney = (amount: number) => ({
    amount,
    currency: "CNY" as const,
  });
  const walletDeployment = deps.walletFunding
    ? JSON.stringify(deps.walletFunding.deployment)
    : null;
  function reservedWalletFunds(userId: string): number {
    return [...mandates.values()].reduce((total, mandate) => {
      if (
        mandate.status !== "active" ||
        agents.get(mandate.agent_id)?.user_id !== userId
      )
        return total;
      const budget = mandate.constraints.find((item) => item.type === "budget");
      return (
        total +
        (budget ? Math.max(0, budget.max.amount - mandate.spent.amount) : 0)
      );
    }, 0);
  }
  function balanceChangePending(userId: string): boolean {
    return (
      [...fundingRecords.values()].some(
        (item) =>
          item.userId === userId &&
          (item.status === "settling" ||
            item.status === "reconciliation_required"),
      ) ||
      [...sweepRecords.values()].some(
        (item) =>
          item.userId === userId &&
          (item.status === "settling" ||
            item.status === "reconciliation_required"),
      ) ||
      [...humanPaymentRecords.values()].some(
        (item) =>
          item.userId === userId &&
          (item.status === "settling" ||
            item.status === "reconciliation_required"),
      ) ||
      [...payments.values()].some(
        (item) =>
          item.userId === userId &&
          (item.status === "settling" ||
            item.status === "reconciliation_required"),
      )
    );
  }
  function humanPaymentPublic(item: HumanPaymentRecord) {
    return {
      schema: "human_payment.v1" as const,
      confirmation_id: item.confirmationId,
      order_id: item.orderId,
      merchant_id: item.merchantId,
      amount: walletMoney(item.amount),
      source_account: "main" as const,
      status: item.status,
      chain: {
        network: "FISCO BCOS local",
        ...(item.txHash ? { tx_hash: item.txHash } : {}),
        ...(item.blockNumber ? { block_number: Number(item.blockNumber) } : {}),
      },
      created_at: item.createdAt,
      ...(item.completedAt ? { completed_at: item.completedAt } : {}),
    };
  }
  function orderCommitted(
    merchantId: string,
    orderId: string,
    excludeAgentPaymentId?: string,
  ): boolean {
    return (
      [...payments.values()].some(
        (item) =>
          item.paymentId !== excludeAgentPaymentId &&
          item.request.merchant_id === merchantId &&
          item.request.order_id === orderId &&
          item.status !== "denied",
      ) ||
      [...humanPaymentRecords.values()].some(
        (item) =>
          item.merchantId === merchantId &&
          item.orderId === orderId &&
          item.status !== "prepared" &&
          item.status !== "failed",
      )
    );
  }
  function fundingPublic(item: FundingRecord) {
    return {
      schema: "funding.v1" as const,
      funding_id: item.fundingId,
      user_id: item.userId,
      amount: walletMoney(item.amount),
      source: "main" as const,
      destination: "agent_wallet" as const,
      status: item.status,
      chain: {
        network: "FISCO BCOS local",
        ...(item.txHash ? { tx_hash: item.txHash } : {}),
        ...(item.blockNumber ? { block_number: Number(item.blockNumber) } : {}),
      },
      created_at: item.createdAt,
      ...(item.completedAt ? { completed_at: item.completedAt } : {}),
    };
  }
  function safeFen(value: bigint): number {
    const number = Number(value);
    if (value < 0n || !Number.isSafeInteger(number))
      throw new Error("Chain balance exceeds supported money range");
    return number;
  }
  const policyHash = (policy: Policy) => sha256(policy);
  function policyChangeHash(
    change: Pick<
      PolicyChange,
      | "userId"
      | "sessionBinding"
      | "changeId"
      | "policyHash"
      | "baseCaps"
      | "baseBlock"
      | "proposed"
      | "deployment"
      | "expiresAt"
    >,
  ) {
    return sha256({
      schema: "policy_change.v1",
      user_id: change.userId,
      session_binding: change.sessionBinding,
      change_id: change.changeId,
      policy_hash: change.policyHash,
      base_caps: change.baseCaps,
      base_block: change.baseBlock,
      proposed: change.proposed,
      deployment: change.deployment,
      expires_at: new Date(change.expiresAt).toISOString(),
    });
  }
  function policyChangePending(userId: string): boolean {
    return [...policyChanges.values()].some(
      (item) => item.userId === userId && item.status === "applying",
    );
  }
  function capsMatchPolicy(caps: PolicyCapsSnapshot, policy: Policy): boolean {
    return (
      caps.perPaymentCap === BigInt(policy.per_payment_max.amount) &&
      caps.dailyCap === BigInt(policy.daily_max.amount) &&
      caps.monthlyCap === BigInt(policy.monthly_max.amount)
    );
  }
  function capsPublic(caps: PolicyCapsSnapshot) {
    return {
      per_payment_max: walletMoney(safeFen(caps.perPaymentCap)),
      daily_max: walletMoney(safeFen(caps.dailyCap)),
      monthly_max: walletMoney(safeFen(caps.monthlyCap)),
      spent_today: walletMoney(safeFen(caps.spentToday)),
      spent_month: walletMoney(safeFen(caps.spentMonth)),
      block_number: caps.blockNumber.toString(),
      observed_at: caps.observedAt,
      next_daily_reset_at: caps.nextDailyResetAt,
      next_monthly_reset_at: caps.nextMonthlyResetAt,
    };
  }
  async function policyGuard(userId: string): Promise<Response | null> {
    if (!deps.walletFunding && !deps.policyCaps) return null;
    if (policyChangePending(userId))
      return error("reconciliation_required", 503);
    if (!deps.policyCaps) return error("chain_unavailable", 503);
    const policy = policies.get(userId);
    if (!policy) return error("policy_denied", 503);
    try {
      const caps = await deps.policyCaps.read();
      return capsMatchPolicy(caps, policy)
        ? null
        : error("reconciliation_required", 503);
    } catch {
      return error("chain_unavailable", 503);
    }
  }
  async function finishPolicyChange(change: PolicyChange): Promise<void> {
    if (change.status !== "applying" || !change.auditHash || !deps.policyCaps)
      throw new Error("Policy change is not ready for reconciliation");
    if (change.deployment !== walletDeployment)
      throw new Error("Policy deployment changed");
    if (change.actionHash !== policyChangeHash(change))
      throw new Error("Policy change action hash changed");
    const policy = policies.get(change.userId);
    if (!policy || policyHash(policy) !== change.policyHash)
      throw new Error("Policy changed before cap confirmation");
    const before = await deps.policyCaps.read();
    const baseMatches =
      before.perPaymentCap === BigInt(change.baseCaps.perPayment) &&
      before.dailyCap === BigInt(change.baseCaps.daily) &&
      before.monthlyCap === BigInt(change.baseCaps.monthly);
    const targetMatches =
      before.perPaymentCap === BigInt(change.proposed.per_payment_max.amount) &&
      before.dailyCap === BigInt(change.proposed.daily_max.amount) &&
      before.monthlyCap === BigInt(change.proposed.monthly_max.amount);
    if (!baseMatches && !targetMatches)
      throw new Error("Unrecognized cap state during policy reconciliation");
    if (!targetMatches)
      change.txHash = await deps.policyCaps.write(change.changeId);
    const after = await deps.policyCaps.read();
    if (
      after.perPaymentCap !== BigInt(change.proposed.per_payment_max.amount) ||
      after.dailyCap !== BigInt(change.proposed.daily_max.amount) ||
      after.monthlyCap !== BigInt(change.proposed.monthly_max.amount)
    )
      throw new Error("Policy cap write lacks exact readback");
    policies.set(
      change.userId,
      PolicySchema.parse({ ...policy, ...change.proposed }),
    );
    change.status = "confirmed";
    try {
      persist();
    } catch (failure) {
      policies.set(change.userId, policy);
      change.status = "applying";
      throw failure;
    }
  }
  function sweepPublic(item: SweepRecord) {
    return {
      schema: "sweep.v1" as const,
      sweep_id: item.sweepId,
      user_id: item.userId,
      amount: walletMoney(item.amount),
      status: item.status,
      chain: {
        network: "FISCO BCOS local",
        ...(item.txHash ? { tx_hash: item.txHash } : {}),
        ...(item.blockNumber ? { block_number: Number(item.blockNumber) } : {}),
      },
      created_at: item.createdAt,
      ...(item.completedAt ? { completed_at: item.completedAt } : {}),
    };
  }
  function transferMatches(
    evidence: { amount: bigint; main: string; wallet: string },
    amount: number,
  ): boolean {
    const deployment = deps.walletFunding?.deployment;
    return (
      !!deployment &&
      evidence.amount === BigInt(amount) &&
      evidence.main.toLowerCase() === deployment.main.toLowerCase() &&
      evidence.wallet.toLowerCase() === deployment.wallet.toLowerCase()
    );
  }
  async function reconcileFunding(item: FundingRecord): Promise<void> {
    const rail = deps.walletFunding;
    if (!rail || item.status !== "reconciliation_required") return;
    if (item.deployment !== walletDeployment) return;
    if (!(await rail.fundingApplied(item.fundingId))) return;
    const evidence = item.txHash
      ? await rail.fundingEvidence(item.txHash, item.fundingId)
      : await rail.findFundingEvidence(
          item.fundingId,
          BigInt(item.startingBlock),
        );
    if (!evidence || !transferMatches(evidence, item.amount)) return;
    item.txHash = evidence.hash;
    item.blockNumber = evidence.blockNumber.toString();
    item.status = "completed";
    item.completedAt = now().toISOString();
    emitEvent(item.userId, "wallet.funded", {
      funding_id: item.fundingId,
      amount: walletMoney(item.amount),
      chain_tx: evidence.hash,
    });
    persist();
  }
  async function reconcileSweep(item: SweepRecord): Promise<void> {
    const rail = deps.walletFunding;
    if (!rail || item.status !== "reconciliation_required") return;
    if (item.deployment !== walletDeployment) return;
    const evidence = item.txHash
      ? await rail.sweepEvidence(item.txHash, item.sweepId)
      : await rail.findSweepEvidence(item.sweepId, BigInt(item.startingBlock));
    if (!evidence || !transferMatches(evidence, item.amount)) return;
    item.txHash = evidence.hash;
    item.blockNumber = evidence.blockNumber.toString();
    item.status = "completed";
    item.completedAt = now().toISOString();
    emitEvent(item.userId, "wallet.swept", {
      sweep_id: item.sweepId,
      amount: walletMoney(item.amount),
      chain_tx: evidence.hash,
    });
    persist();
  }

  async function writeAudit(input: {
    kind: AuditRecord["kind"];
    actor: string;
    subjectId: string;
    summary: string;
    data: unknown;
  }): Promise<AuditRecord> {
    const createdAt = now().toISOString();
    const auditId = id("aud");
    const recordHash = sha256({ auditId, ...input, createdAt });
    const chainTx = await deps.anchorAudit(
      recordHash,
      input.subjectId,
      input.kind,
    );
    const record = AuditRecordSchema.parse({
      schema: "audit.v1",
      audit_id: auditId,
      kind: input.kind,
      actor: input.actor,
      subject_id: input.subjectId,
      summary: input.summary,
      record_hash: recordHash,
      chain_tx: chainTx,
      created_at: createdAt,
    });
    audits.push(record);
    const auditUserId = agents.get(input.actor)?.user_id ?? input.actor;
    emitEvent(auditUserId, "audit.created", {
      audit_id: record.audit_id,
      kind: record.kind,
    });
    return record;
  }

  function flagsInWindow(agentId: string): number {
    const cutoff = now().getTime() - 30 * 86_400_000;
    return trustEvents.filter(
      (item) =>
        item.agent_id === agentId &&
        item.kind === "flag" &&
        Date.parse(item.occurred_at) >= cutoff,
    ).length;
  }

  async function recordTrustEvent(
    agent: Agent,
    kind: TrustEvent["kind"],
    sourceId: string,
    reason: string,
    target?: "AMBER" | "GREEN" | "RED",
    forceChain = false,
    evidenceHash?: string,
    occurredAt?: string,
  ): Promise<TrustEvent> {
    const existing = trustEvents.find(
      (item) =>
        item.agent_id === agent.agent_id &&
        item.kind === kind &&
        item.source_id === sourceId,
    );
    if (existing) {
      if (existing.evidence_hash !== evidenceHash)
        throw new Error("Trust evidence changed for an existing incident");
      return existing;
    }
    const previouslyPending = trustPending.get(agent.agent_id);
    if (previouslyPending) {
      if (
        previouslyPending.kind !== kind ||
        previouslyPending.sourceId !== sourceId ||
        previouslyPending.evidenceHash !== evidenceHash
      )
        throw new Error("Agent trust evidence requires reconciliation");
      return finishTrustIntent(agent, previouslyPending);
    }
    const oldLight = agent.licence.level;
    const nextLight = target ?? oldLight;
    const pending: TrustIntent = {
      intentId: id("tev"),
      agentId: agent.agent_id,
      kind,
      sourceId,
      from: oldLight,
      level: nextLight,
      reason,
      occurredAt: occurredAt ?? now().toISOString(),
      status: "pending",
      forceChain,
      evidenceHash,
    };
    trustPending.set(agent.agent_id, pending);
    persist();
    return finishTrustIntent(agent, pending);
  }

  async function finishTrustIntent(
    agent: Agent,
    pending: TrustIntent,
  ): Promise<TrustEvent> {
    const {
      intentId,
      kind,
      sourceId,
      from: oldLight,
      level: nextLight,
      reason,
    } = pending;
    const facts = {
      event_id: intentId,
      agent_id: agent.agent_id,
      kind,
      source_id: sourceId,
      from: oldLight,
      to: nextLight,
      reason,
      ...(pending.evidenceHash ? { evidence_hash: pending.evidenceHash } : {}),
      occurred_at: pending.occurredAt,
    };
    if (pending.status !== "anchored") {
      const audit = await writeAudit({
        kind:
          kind === "drill_passed" || kind === "drill_failed"
            ? "drill"
            : "licence_change",
        actor: agent.user_id,
        subjectId: agent.agent_id,
        summary: reason,
        data: {
          ...facts,
          public_key: agent.public_key,
          ...(nextLight === "RED" && oldLight !== "RED"
            ? {
                retiring_approval_ids: [...approvals.values()]
                  .filter(
                    (entry) =>
                      entry.card.status === "pending" &&
                      ((entry.mandateId &&
                        mandates.get(entry.mandateId)?.agent_id ===
                          agent.agent_id) ||
                        (entry.paymentId &&
                          payments.get(entry.paymentId)?.agentId ===
                            agent.agent_id)),
                  )
                  .map((entry) => entry.card.approval_id),
                retiring_mandate_ids: [...mandates.values()]
                  .filter(
                    (mandate) =>
                      mandate.agent_id === agent.agent_id &&
                      (mandate.status === "active" ||
                        mandate.status === "pending_user" ||
                        mandate.status === "pending_checkout"),
                  )
                  .map((mandate) => mandate.mandate_id),
              }
            : {}),
        },
      });
      pending.status = "anchored";
      pending.auditHash = audit.record_hash;
      persist();
    }
    if (!pending.auditHash) throw new Error("Trust intent audit is missing");
    let chainTx: `0x${string}` | undefined;
    if (nextLight !== oldLight || pending.forceChain) {
      if (!deps.setTrustLight)
        throw new Error("Bank trust-light writer unavailable");
      chainTx = await deps.setTrustLight(agent, nextLight, intentId);
    }
    if (nextLight === "RED" && oldLight !== "RED") {
      if (!(await retireRedAgentAuthority(agent)))
        throw new Error("Red authority retirement requires reconciliation");
    }
    const confirmedAt = now().toISOString();
    const event = TrustEventSchema.parse({
      schema: "trust_event.v1",
      ...facts,
      ...(nextLight !== oldLight || pending.forceChain
        ? { confirmed_at: confirmedAt }
        : {}),
      audit_hash: pending.auditHash,
      ...(chainTx ? { chain_tx: chainTx } : {}),
    });
    const priorLicence = { ...agent.licence };
    trustEvents.push(event);
    try {
      agent.licence.level = nextLight;
      agent.licence.reason = reason;
      if (nextLight !== oldLight || pending.forceChain)
        agent.licence.updated_at = confirmedAt;
      agent.licence.flags_30d = flagsInWindow(agent.agent_id);
      if (kind === "clean_purchase")
        agent.licence.clean_purchases = Math.max(
          agent.licence.clean_purchases,
          trustEvents.filter(
            (item) =>
              item.agent_id === agent.agent_id &&
              item.kind === "clean_purchase",
          ).length,
        );
      if (kind === "drill_passed") agent.licence.drills_passed++;
      if (kind === "drill_failed") agent.licence.drills_failed++;
      trustPending.delete(agent.agent_id);
      persist();
    } catch (failure) {
      const at = trustEvents.lastIndexOf(event);
      if (at >= 0) trustEvents.splice(at, 1);
      Object.assign(agent.licence, priorLicence);
      trustPending.set(agent.agent_id, pending);
      throw failure;
    }
    emitEvent(agent.user_id, "agent.licence_changed", {
      agent_id: agent.agent_id,
      from: oldLight,
      to: nextLight,
      reason,
      trust_event_id: event.event_id,
    });
    return event;
  }

  function latestAmberEntryIndex(agentId: string): number {
    for (let index = trustEvents.length - 1; index >= 0; index--) {
      const event = trustEvents[index];
      if (
        event &&
        event.agent_id === agentId &&
        event.to === "AMBER" &&
        event.from !== "AMBER"
      )
        return index;
    }
    return -1;
  }

  async function maybePromoteAmber(agent: Agent): Promise<void> {
    if (agent.licence.level !== "AMBER" || trustPending.has(agent.agent_id))
      return;
    const resetIndex = latestAmberEntryIndex(agent.agent_id);
    const reset = trustEvents[resetIndex];
    const epoch = reset?.event_id ?? "initial";
    const confirmedReset = reset
      ? Date.parse(reset.confirmed_at ?? reset.occurred_at)
      : null;
    const eligible = trustEvents
      .slice(resetIndex + 1)
      .filter((item) => item.agent_id === agent.agent_id);
    const clean = eligible.filter((item) => {
      if (item.kind !== "clean_purchase") return false;
      const paidAt = payments.get(item.source_id)?.paidAt;
      if (!paidAt) return false;
      return confirmedReset === null || Date.parse(paidAt) > confirmedReset;
    }).length;
    const passed = eligible.some(
      (item) =>
        item.kind === "drill_passed" &&
        (confirmedReset === null ||
          Date.parse(item.occurred_at) > confirmedReset),
    );
    if (clean < 5 || !passed || flagsInWindow(agent.agent_id) !== 0) return;
    await recordTrustEvent(
      agent,
      "transition",
      `earned-green:${agent.agent_id}:${epoch}`,
      "Five clean owner-approved purchases and a bank-recorded passed drill in this Amber period",
      "GREEN",
    );
  }

  async function flagTrust(
    agent: Agent,
    sourceId: string,
    reason: string,
  ): Promise<void> {
    if (
      trustEvents.some(
        (item) =>
          item.agent_id === agent.agent_id &&
          item.kind === "flag" &&
          item.source_id === sourceId,
      )
    )
      return;
    const nextCount = flagsInWindow(agent.agent_id) + 1;
    const target =
      nextCount >= 2
        ? "RED"
        : agent.licence.level === "GREEN"
          ? "AMBER"
          : agent.licence.level;
    await recordTrustEvent(agent, "flag", sourceId, reason, target);
  }

  function recordRiskAttempt(
    agentId: string,
    merchantId: string,
    orderId: string,
  ): void {
    if (
      riskAttempts.some(
        (item) =>
          item.agentId === agentId &&
          item.merchantId === merchantId &&
          item.orderId === orderId,
      )
    )
      return;
    riskAttempts.push({
      agentId,
      merchantId,
      orderId,
      at: now().toISOString(),
    });
    persist();
  }

  function approvalCard(
    kind: "mandate" | "payment" | "pairing" | "policy_loosen",
    level: "zero_trust" | "everyday",
    subjectId: string,
    title: string,
    lines: string[],
    payload: unknown,
    ttlSeconds = ttl,
  ): Approval {
    return ApprovalSchema.parse({
      schema: "approval.v1",
      approval_id: id("apr"),
      kind,
      level,
      subject_id: subjectId,
      title,
      lines,
      payload_hash: sha256(payload),
      expires_at: new Date(now().getTime() + ttlSeconds * 1000).toISOString(),
      status: "pending",
    });
  }

  function compositeReviewHash(
    review: PaymentReview,
    userId: string,
    decision: StoredPayment["decision"],
  ): `sha256:${string}` {
    const { payload_hash: _payloadHash, ...facts } = review;
    return sha256({
      schema: "payment_review_action.v1",
      owner_id: userId,
      review: facts,
      decision,
    });
  }

  function compositePaymentCard(
    agent: Agent,
    mandate: Mandate,
    payment: StoredPayment,
    paymentUri: string,
    paymentLines: string[],
    firstPayment: boolean,
  ): Approval {
    const approvalId = id("apr");
    const expiresAt = new Date(now().getTime() + ttl * 1000).toISOString();
    const lockedMandate = MandateSchema.parse({
      ...structuredClone(mandate),
      in_flight_payment_id: null,
    });
    const review = PaymentReviewSchema.parse({
      schema: "payment_review.v1",
      status: "pending",
      approval_id: approvalId,
      payment_id: payment.paymentId,
      payload_hash: `sha256:${"0".repeat(64)}`,
      expires_at: expiresAt,
      mandate_snapshot: {
        mandate: lockedMandate,
        canonical_hash: sha256(lockedMandate),
      },
      signed_order: {
        payment_request_hash: `sha256:${createHash("sha256").update(paymentUri, "utf8").digest("hex")}`,
        merchant_id: payment.merchant.merchant_id,
        merchant_legal_name: payment.merchant.legal_name,
        merchant_uscc: payment.merchant.uscc,
        order_id: payment.request.order_id,
        line_items: structuredClone(payment.request.line_items),
        amount: structuredClone(payment.request.amount),
        expires_at: payment.request.expires_at,
      },
      decision_checks: structuredClone(payment.decision.checks),
    });
    review.payload_hash = compositeReviewHash(
      review,
      agent.user_id,
      payment.decision,
    );
    payment.review = review;
    return ApprovalSchema.parse({
      schema: "approval.v1",
      approval_id: approvalId,
      kind: "payment",
      review_schema: "payment_review.v1",
      subject_id: payment.paymentId,
      title: `${agent.display_name} wants to pay ${payment.request.amount.amount / 100} ${payment.request.amount.currency}`,
      lines: [
        `User request (agent-reported): ${lockedMandate.user_text}`,
        `Locked intent: ${lockedMandate.intent_level}; ${lockedMandate.description}`,
        ...lockedMandate.constraints.map(
          (constraint) => `Locked constraint: ${canonicalJson(constraint)}`,
        ),
        ...paymentLines,
        `Order: ${payment.request.order_id}`,
        `Exact total: ${payment.request.amount.amount / 100} ${payment.request.amount.currency}`,
      ],
      payload_hash: review.payload_hash,
      level: firstPayment ? "zero_trust" : "everyday",
      expires_at: expiresAt,
      status: "pending",
    });
  }

  function compositeReviewStillMatches(
    entry: ApprovalEntry,
    payment: StoredPayment,
    mandate: Mandate,
  ): boolean {
    if (!payment.review || !payment.paymentUri) return false;
    if (
      mandate.status !== "pending_checkout" ||
      mandate.approval_timing !== "payment" ||
      mandate.in_flight_payment_id !== payment.paymentId
    )
      return false;
    const review = PaymentReviewSchema.safeParse(payment.review);
    if (!review.success) return false;
    const card = entry.card;
    const facts = review.data;
    if (
      card.review_schema !== "payment_review.v1" ||
      facts.approval_id !== card.approval_id ||
      facts.payment_id !== payment.paymentId ||
      facts.expires_at !== card.expires_at ||
      facts.payload_hash !== card.payload_hash ||
      compositeReviewHash(facts, entry.userId, payment.decision) !==
        card.payload_hash
    )
      return false;
    const originalMandate = MandateSchema.safeParse({
      ...mandate,
      in_flight_payment_id: null,
    });
    if (!originalMandate.success) return false;
    if (
      sha256(originalMandate.data) !== facts.mandate_snapshot.canonical_hash ||
      sha256(facts.mandate_snapshot.mandate) !==
        facts.mandate_snapshot.canonical_hash
    )
      return false;
    const signedOrder = {
      payment_request_hash: `sha256:${createHash("sha256").update(payment.paymentUri, "utf8").digest("hex")}`,
      merchant_id: payment.merchant.merchant_id,
      merchant_legal_name: payment.merchant.legal_name,
      merchant_uscc: payment.merchant.uscc,
      order_id: payment.request.order_id,
      line_items: payment.request.line_items,
      amount: payment.request.amount,
      expires_at: payment.request.expires_at,
    };
    if (sha256(signedOrder) !== sha256(facts.signed_order)) return false;
    try {
      return (
        sha256(decodePaymentRequestUri(payment.paymentUri)) ===
        sha256(payment.request)
      );
    } catch {
      return false;
    }
  }

  function contractPayDenial(reason: string): {
    rule: DenialRule;
    checkReason: string;
  } | null {
    const known: Record<string, { rule: DenialRule; checkReason: string }> = {
      "over payment cap": {
        rule: "over_per_payment_cap",
        checkReason: "per_payment_cap_exceeded",
      },
      "over daily cap": {
        rule: "over_daily_cap",
        checkReason: "daily_cap_exceeded",
      },
      "over monthly cap": {
        rule: "over_monthly_cap",
        checkReason: "monthly_cap_exceeded",
      },
      insufficient: {
        rule: "insufficient_wallet_funds",
        checkReason: "insufficient_wallet_funds",
      },
      "already paid": {
        rule: "duplicate_payment",
        checkReason: "duplicate_payment",
      },
      "merchant inactive": {
        rule: "merchant_unknown",
        checkReason: "merchant_unknown",
      },
    };
    return known[reason] ?? null;
  }

  function recordContractDenial(
    payment: StoredPayment,
    checkReason: string,
  ): void {
    payment.decision = DecisionSchema.parse({
      ...payment.decision,
      checks: payment.decision.checks.map((check) =>
        check.name === "rail_validation"
          ? {
              ...check,
              result: "deny" as const,
              detail: {
                ...check.detail,
                reason: checkReason,
                contract_rechecked: true,
              },
            }
          : check,
      ),
    });
  }

  async function checkVerifiedMandateProduct(
    mandate: Mandate,
    paymentRequest: PaymentRequest,
    merchant: Merchant,
    allowPendingCheckout = false,
  ): Promise<Check> {
    const check = checkMandate(
      mandate,
      paymentRequest,
      merchant,
      now(),
      allowPendingCheckout,
    );
    if (check.result === "deny") return check;
    const product = mandate.constraints.find((item) => item.type === "product");
    if (!product?.brand || !product.model || product.gtin) return check;
    const expectedBrand = product.brand.trim().toLowerCase();
    const expectedModel = product.model.trim().toLowerCase();
    for (const item of paymentRequest.line_items) {
      if (item.type !== "product") continue;
      const trusted = deps.lookupVariant
        ? await deps.lookupVariant(item.sku)
        : (demoVariantBySku(item.sku) ?? null);
      if (
        !trusted ||
        trusted.merchant_id !== merchant.merchant_id ||
        trusted.gtin !== item.gtin ||
        trusted.brand.trim().toLowerCase() !== expectedBrand ||
        trusted.model.trim().toLowerCase() !== expectedModel
      )
        return {
          name: "mandate",
          result: "deny",
          detail: { reason: "product_model_mismatch" },
        };
    }
    return check;
  }

  function storeApproval(entry: ApprovalEntry): void {
    approvals.set(entry.card.approval_id, entry);
    emitEvent(entry.userId, "approval.created", { approval: entry.card });
    scheduleApprovalExpiry(entry);
  }

  function scheduleApprovalExpiry(entry: ApprovalEntry): void {
    if (entry.card.status !== "pending") return;
    const delay = Math.max(
      0,
      Date.parse(entry.card.expires_at) - now().getTime(),
    );
    const timer = setTimeout(() => {
      expiryTimers.delete(timer);
      void expireApproval(entry)
        .then(() => persist())
        .catch((failure: unknown) => {
          app.log.error({ failure }, "Approval expiry requires reconciliation");
        });
    }, delay);
    timer.unref();
    expiryTimers.add(timer);
  }
  for (const entry of approvals.values()) scheduleApprovalExpiry(entry);

  async function makeReceipt(
    payment: StoredPayment,
    outcome: "APPROVED" | "DENIED",
    paymentTx?: `0x${string}`,
  ): Promise<Receipt> {
    const audit = await writeAudit({
      kind: "payment_decision",
      actor: payment.agentId,
      subjectId: payment.decision.decision_id,
      summary: `${outcome} ${payment.request.amount.amount} ${payment.request.amount.currency} to ${payment.merchant.name}`,
      data: {
        payment_id: payment.paymentId,
        decision: payment.decision,
        merchant_id: payment.merchant.merchant_id,
        order_id: payment.request.order_id,
        amount: payment.request.amount,
      },
    });
    const unsigned = {
      schema: "receipt.v1" as const,
      receipt_id: id("rcp"),
      payment_id: payment.paymentId,
      decision_id: payment.decision.decision_id,
      mandate_id: payment.mandateId,
      merchant_id: payment.merchant.merchant_id,
      merchant_legal_name: payment.merchant.legal_name,
      merchant_uscc: payment.merchant.uscc,
      order_id: payment.request.order_id,
      amount: payment.request.amount,
      outcome,
      chain: {
        network: "fisco-local-20200",
        ...(paymentTx ? { payment_tx: paymentTx } : {}),
        audit_tx: audit.chain_tx,
      },
      issued_at: now().toISOString(),
    };
    const signature = await deps.signReceipt(
      Buffer.from(canonicalJson(unsigned), "utf8"),
    );
    return ReceiptSchema.parse({ ...unsigned, webank_sig: signature });
  }

  async function settle(
    payment: StoredPayment,
    outcome: "APPROVED" | "DENIED",
    explanation: string,
    explicitDenial?: Parameters<typeof denial>[0],
  ): Promise<Response> {
    const mandate = mandates.get(payment.mandateId);
    if (!mandate) return agentDenied("mandate_not_found");
    if (outcome === "APPROVED") {
      const blocked = await policyGuard(payment.userId);
      if (blocked) return blocked;
    }
    try {
      if (
        outcome === "APPROVED" &&
        deps.walletFunding &&
        balanceChangePending(payment.userId)
      )
        return error("reconciliation_required", 503);
      if (outcome === "APPROVED") {
        const currentAgent = agents.get(payment.agentId);
        const currentMerchant = await deps.lookupMerchant(
          payment.merchant.merchant_id,
        );
        if (
          currentAgent?.status !== "active" ||
          currentAgent?.deleted_at ||
          (currentAgent ? idleRequired(currentAgent) : true) ||
          replacingAgents.has(payment.agentId) ||
          currentAgent.licence.level === "RED" ||
          trustPending.has(payment.agentId) ||
          mandate.in_flight_payment_id !== payment.paymentId ||
          Date.parse(payment.request.expires_at) <= now().getTime() ||
          !currentMerchant ||
          currentMerchant.public_key !== payment.merchant.public_key ||
          currentMerchant.payout !== payment.merchant.payout ||
          currentMerchant.legal_name !== payment.merchant.legal_name ||
          currentMerchant.uscc !== payment.merchant.uscc ||
          currentMerchant.honeypot ||
          (
            await checkVerifiedMandateProduct(
              mandate,
              payment.request,
              currentMerchant,
            )
          ).result === "deny"
        ) {
          outcome = "DENIED";
          explanation =
            "The agent, merchant, or mandate changed before settlement.";
        }
        if (
          outcome === "APPROVED" &&
          orderCommitted(
            payment.request.merchant_id,
            payment.request.order_id,
            payment.paymentId,
          )
        ) {
          outcome = "DENIED";
          explanation = "This merchant order is already being paid.";
          explicitDenial = "duplicate_payment";
        }
      }
      if (payment.status !== "awaiting_user")
        return payment.status === "settling" ||
          payment.status === "reconciliation_required"
          ? reconciliationError(payment)
          : error("action_changed", 409);
      let paymentTx: `0x${string}` | undefined;
      if (outcome === "APPROVED") {
        payment.status = "settling";
        persist();
        paymentTx = await deps.executePayment({
          paymentId: payment.paymentId,
          mandate,
          request: payment.request,
          merchant: payment.merchant,
        });
        payment.settlementTx = paymentTx;
        persist();
      }
      payment.decision = DecisionSchema.parse({
        ...payment.decision,
        outcome,
        user_explanation: explanation,
      });
      payment.receipt = await makeReceipt(payment, outcome, paymentTx);
      if (outcome === "APPROVED" && paymentTx && deps.notifyMerchantPayment) {
        await deps.notifyMerchantPayment({
          orderId: payment.request.order_id,
          paymentTx,
        });
      }
      payment.status = outcome === "APPROVED" ? "paid" : "denied";
      if (outcome === "APPROVED") payment.paidAt = now().toISOString();
      emitEvent(
        payment.userId,
        outcome === "APPROVED" ? "payment.completed" : "payment.denied",
        outcome === "APPROVED"
          ? {
              payment_id: payment.paymentId,
              outcome,
              amount: payment.request.amount,
              merchant: payment.merchant.name,
              receipt_id: payment.receipt.receipt_id,
            }
          : {
              payment_id: payment.paymentId,
              user_explanation: payment.decision.user_explanation,
            },
      );
      mandate.in_flight_payment_id = null;
      if (outcome === "APPROVED") {
        mandate.spent.amount += payment.request.amount.amount;
        mandate.occurrences++;
        const agent = agents.get(payment.agentId);
        if (agent) {
          agent.last_used_at = now().toISOString();
          if (payment.approvalSource === "owner" && payment.approvalId) {
            try {
              await recordTrustEvent(
                agent,
                "clean_purchase",
                payment.paymentId,
                "Owner-approved paid purchase verified",
                undefined,
                false,
                undefined,
                payment.paidAt,
              );
              await maybePromoteAmber(agent);
            } catch (failure) {
              app.log.error(
                { failure, agentId: agent.agent_id },
                "Trust evidence requires reconciliation",
              );
            }
          }
        }
        const budget = budgetOf(mandate);
        const recurrence = mandate.constraints.find(
          (item) => item.type === "recurrence",
        );
        if (
          (budget !== null && mandate.spent.amount >= budget) ||
          (recurrence && mandate.occurrences >= recurrence.max_occurrences)
        ) {
          mandate.status = "exhausted";
          try {
            await deps.releaseMandate(mandate);
          } catch {
            // A failed release leaves funds reserved but cannot undo a settled payment.
          }
        }
        return {
          statusCode: 200,
          body: PaidPaymentResponseSchema.parse({
            payment_id: payment.paymentId,
            status: "paid",
            decision: payment.decision,
            receipt: payment.receipt,
          }),
        };
      }
      if (payment.review) {
        if (mandate.status === "active") {
          try {
            await deps.releaseMandate(mandate);
          } catch {
            // The composite mandate remains unusable even if a hold lingers.
          }
        }
        mandate.status = "cancelled";
      }
      const denialError = explicitDenial
        ? denial(explicitDenial)
        : payment.decision.checks.some((check) => check.result === "deny")
          ? denialFromChecks(payment.decision.checks)
          : undefined;
      payment.denialError = denialError;
      if (!denialError)
        return {
          statusCode: 200,
          body: PaymentStatusResponseSchema.parse({
            payment_id: payment.paymentId,
            status: "denied",
            decision: payment.decision,
            receipt: payment.receipt,
          }),
        };
      return {
        statusCode: 403,
        body: DeniedPaymentResponseSchema.parse({
          payment_id: payment.paymentId,
          status: "denied",
          decision: payment.decision,
          receipt: payment.receipt,
          error: denialError,
        }),
      };
    } catch (failure) {
      const provenDenial =
        failure instanceof ChainRevertError
          ? contractPayDenial(failure.reason)
          : null;
      if (
        provenDenial &&
        payment.status === "settling" &&
        !payment.settlementTx
      ) {
        try {
          const explanation = denial(provenDenial.rule).user_explanation;
          recordContractDenial(payment, provenDenial.checkReason);
          payment.decision = DecisionSchema.parse({
            ...payment.decision,
            outcome: "DENIED",
            user_explanation: explanation,
          });
          payment.receipt = await makeReceipt(payment, "DENIED");
          if (payment.review && mandate.status === "active")
            await deps.releaseMandate(mandate);
          payment.denialError = denial(provenDenial.rule);
          payment.status = "denied";
          mandate.in_flight_payment_id = null;
          if (payment.review) mandate.status = "cancelled";
          persist();
          return {
            statusCode: 403,
            body: DeniedPaymentResponseSchema.parse({
              payment_id: payment.paymentId,
              status: "denied",
              decision: payment.decision,
              receipt: payment.receipt,
              error: payment.denialError,
            }),
          };
        } catch {
          // Receipt or audit failure remains uncertain to the caller.
        }
      }
      payment.status = "reconciliation_required";
      emitEvent(payment.userId, "payment.reconciliation_required", {
        payment_id: payment.paymentId,
        ...(payment.settlementTx ? { payment_tx: payment.settlementTx } : {}),
      });
      return reconciliationError(payment);
    }
  }

  function reconciliationError(payment: StoredPayment): Response {
    return {
      statusCode: 503,
      body: {
        error: {
          code: "reconciliation_required",
          decision_id: payment.decision.decision_id,
          payment_id: payment.paymentId,
          ...(payment.settlementTx ? { payment_tx: payment.settlementTx } : {}),
        },
      },
    };
  }

  async function expireApproval(entry: ApprovalEntry): Promise<void> {
    if (
      entry.card.status !== "pending" ||
      Date.parse(entry.card.expires_at) > now().getTime()
    )
      return;
    entry.card.status = "expired";
    emitEvent(entry.userId, "approval.resolved", {
      approval_id: entry.card.approval_id,
      status: "expired",
    });
    if (entry.mandateId) {
      const mandate = mandates.get(entry.mandateId);
      if (mandate) mandate.status = "expired";
    }
    if (entry.paymentId) {
      const payment = payments.get(entry.paymentId);
      if (payment?.status === "awaiting_user") {
        await settle(
          payment,
          "DENIED",
          `Approval timed out after ${ttl} seconds.`,
        );
        if (payment.review) {
          const mandate = mandates.get(payment.mandateId);
          if (mandate?.status === "cancelled") mandate.status = "expired";
        }
      }
    }
  }

  async function expireDueApprovals(): Promise<void> {
    for (const entry of approvals.values()) await expireApproval(entry);
  }

  async function rejectedAttempt(
    agent: Agent,
    code: string,
    statusCode: number,
    data: Record<string, unknown>,
  ): Promise<Response> {
    const decisionId = id("dec");
    await writeAudit({
      kind: "payment_decision",
      actor: agent.agent_id,
      subjectId: decisionId,
      summary: `DENIED before a verified payment request: ${code}`,
      data,
    });
    if (
      typeof data.merchant_id === "string" &&
      typeof data.order_id === "string"
    )
      recordRiskAttempt(agent.agent_id, data.merchant_id, data.order_id);
    if (
      [
        "mandate_not_found",
        "mandate_budget_exceeded",
        "merchant_outside_mandate",
        "category_outside_mandate",
        "variant_sku_mismatch",
      ].includes(code)
    )
      await flagTrust(
        agent,
        `attempt:${String(data.merchant_id ?? "unknown")}:${String(data.order_id ?? sha256(data))}`,
        `Verified payment attempt outside mandate or hard policy: ${code}`,
      );
    if (statusCode === 403 && code === "merchant_unknown")
      return agentDenied("merchant_unknown");
    if (statusCode === 403 && code === "variant_sku_mismatch")
      return agentDenied("variant_sku_mismatch", data);
    if (statusCode === 403 && code === "duplicate_payment")
      return agentDenied("duplicate_payment", data);
    return error(code, statusCode, decisionId);
  }

  async function submitPayment(
    agent: Agent,
    raw: unknown,
    request?: FastifyRequest,
  ): Promise<Response> {
    const blocked = await policyGuard(agent.user_id);
    if (blocked) return blocked;
    if (deps.walletFunding && balanceChangePending(agent.user_id))
      return error("reconciliation_required", 503);
    const parsed = CreatePaymentRequestSchema.safeParse(raw);
    if (!parsed.success) return error("payreq_invalid", 400);
    const body = parsed.data;
    if (!body.mandate_id)
      return agentDenied("mandate_required", {
        required_fields: [
          "description",
          "user_text",
          "intent_level",
          "constraints",
        ],
      });
    await expireDueApprovals();
    const mandate = mandates.get(body.mandate_id);
    if (!mandate || mandate.agent_id !== agent.agent_id)
      return agentDenied("mandate_not_found");
    if (mandate.agent_key_binding !== agent.public_key)
      return agentDenied("agent_key_mismatch");
    if (mandate.status === "pending_user") {
      const pending = [...approvals.values()].find(
        (entry) =>
          entry.mandateId === mandate.mandate_id &&
          entry.card.status === "pending",
      );
      if (!pending) return agentDenied("mandate_not_found");
      return {
        statusCode: 202,
        body: PendingMandatePaymentResponseSchema.parse({
          mandate_id: mandate.mandate_id,
          status: "awaiting_user",
          approval_id: pending.card.approval_id,
          level: pending.card.level,
          expires_at: pending.card.expires_at,
        }),
      };
    }
    const composite =
      mandate.status === "pending_checkout" &&
      mandate.approval_timing === "payment";
    if (mandate.status === "pending_checkout" && !composite)
      return agentDenied("mandate_not_found");
    if (mandate.status === "cancelled") return agentDenied("mandate_cancelled");
    if (mandate.status === "exhausted") return agentDenied("mandate_exhausted");
    if (mandate.status === "expired") return agentDenied("mandate_expired");
    if (mandate.approval_timing === "payment" && !composite)
      return error("mandate_in_flight", 409);
    const window = mandate.constraints.find(
      (constraint) => constraint.type === "execution_window",
    );
    if (window && Date.parse(window.not_after) <= now().getTime())
      return agentDenied("execution_window_closed");
    let paymentRequest: PaymentRequest;
    try {
      paymentRequest = decodePaymentRequestUri(body.payment_request);
    } catch {
      return rejectedAttempt(agent, "payreq_invalid", 400, {
        payment_request_hash: sha256(body.payment_request),
      });
    }
    const merchant = await deps.lookupMerchant(paymentRequest.merchant_id);
    if (!merchant)
      return rejectedAttempt(agent, "merchant_unknown", 403, {
        merchant_id: paymentRequest.merchant_id,
        order_id: paymentRequest.order_id,
      });
    if (!verifyMerchantSignature(paymentRequest, merchant.public_key))
      return rejectedAttempt(agent, "payreq_invalid", 400, {
        merchant_id: merchant.merchant_id,
        order_id: paymentRequest.order_id,
        reason: "merchant_signature_invalid",
      });
    for (const item of paymentRequest.line_items) {
      if (item.type !== "product") continue;
      const known = deps.lookupVariant
        ? await deps.lookupVariant(item.sku)
        : (demoVariantBySku(item.sku) ?? null);
      if (
        !known ||
        known.merchant_id !== paymentRequest.merchant_id ||
        known.gtin !== item.gtin ||
        known.variant !== item.variant ||
        known.options.colour !== item.options.colour ||
        known.options.size !== item.options.size ||
        Object.keys(known.options).length !== Object.keys(item.options).length
      )
        return rejectedAttempt(agent, "variant_sku_mismatch", 403, {
          merchant_id: paymentRequest.merchant_id,
          order_id: paymentRequest.order_id,
          sku: item.sku,
        });
    }
    if (Date.parse(paymentRequest.expires_at) <= now().getTime())
      return rejectedAttempt(agent, "payreq_invalid", 400, {
        merchant_id: merchant.merchant_id,
        order_id: paymentRequest.order_id,
        reason: "payment_request_expired",
      });
    const lineTotal = paymentRequest.line_items.reduce(
      (sum, item) => sum + item.qty * item.unit_price.amount,
      0,
    );
    if (
      !Number.isSafeInteger(lineTotal) ||
      lineTotal !== paymentRequest.amount.amount
    )
      return rejectedAttempt(agent, "payreq_invalid", 400, {
        merchant_id: merchant.merchant_id,
        order_id: paymentRequest.order_id,
        reason: "signed_line_total_mismatch",
      });
    const policy = policies.get(agent.user_id);
    const budgetLimit = mandate.constraints.find(
      (constraint) => constraint.type === "budget",
    );
    const amountLimit = mandate.constraints.find(
      (constraint) => constraint.type === "amount_range",
    );
    const recurrenceLimit = mandate.constraints.find(
      (constraint) => constraint.type === "recurrence",
    );
    const categoryLimit = mandate.constraints.find(
      (constraint) => constraint.type === "categories",
    );
    if (
      !policy ||
      !budgetLimit ||
      !amountLimit ||
      !recurrenceLimit ||
      !categoryLimit ||
      !window
    )
      return error("service_unavailable", 503);
    if (
      budgetLimit.max.currency !== policy.per_payment_max.currency ||
      amountLimit.max.currency !== policy.per_payment_max.currency ||
      mandate.spent.currency !== policy.per_payment_max.currency
    )
      return error("service_unavailable", 503);
    if (paymentRequest.amount.currency !== policy.per_payment_max.currency)
      return error("payreq_invalid", 400);
    if (mandate.in_flight_payment_id) return error("mandate_in_flight", 409);
    if (orderCommitted(paymentRequest.merchant_id, paymentRequest.order_id))
      return rejectedAttempt(agent, "duplicate_payment", 403, {
        merchant_id: paymentRequest.merchant_id,
        order_id: paymentRequest.order_id,
      });
    const nonceKey = `${paymentRequest.merchant_id}:${paymentRequest.nonce}`;
    if (usedMerchantNonces.has(nonceKey))
      return rejectedAttempt(agent, "payreq_invalid", 400, {
        merchant_id: paymentRequest.merchant_id,
        order_id: paymentRequest.order_id,
        reason: "merchant_nonce_reused",
      });
    usedMerchantNonces.add(nonceKey);
    const priorHour = now().getTime() - 3_600_000;
    const earlierPaymentAttemptsHour = riskAttempts.filter(
      (item) =>
        item.agentId === agent.agent_id && Date.parse(item.at) >= priorHour,
    ).length;
    const paidWithoutTime = [...payments.values()].some(
      (item) =>
        item.agentId === agent.agent_id &&
        item.status === "paid" &&
        !item.paidAt,
    );
    const earlierPaidOrdersHour = [...payments.values()].filter(
      (item) =>
        item.agentId === agent.agent_id &&
        item.status === "paid" &&
        item.paidAt &&
        Date.parse(item.paidAt) >= priorHour,
    ).length;
    recordRiskAttempt(
      agent.agent_id,
      paymentRequest.merchant_id,
      paymentRequest.order_id,
    );

    const paymentId = id("pay");
    if (request) {
      const mapKey = `${agent.agent_id}:${request.method}:${request.url}:${request.headers["idempotency-key"]}`;
      const entry = idempotency.get(mapKey);
      if (entry) entry.paymentId = paymentId;
    }
    mandate.in_flight_payment_id = paymentId;
    try {
      const railCheck: Check = {
        name: "rail_validation",
        result: merchant.honeypot ? "deny" : "pass",
        detail: {
          merchant_verified: merchant.name,
          category: merchant.category,
          honeypot: merchant.honeypot,
          ...(merchant.honeypot ? { reason: "fire_drill_decoy" } : {}),
        },
      };
      const checks: Check[] = [
        { name: "agent_auth", result: "pass" },
        railCheck,
      ];
      const mandateCheck: Check = checks.some(
        (check) => check.result === "deny",
      )
        ? { name: "mandate", result: "skipped" }
        : await checkVerifiedMandateProduct(
            mandate,
            paymentRequest,
            merchant,
            composite,
          );
      checks.push(mandateCheck);
      let policyCheck: Check = checks.some((check) => check.result === "deny")
        ? { name: "policy_licence", result: "skipped" }
        : { name: "policy_licence", result: "pass" };
      if (policyCheck.result !== "skipped") {
        const { spentToday: paidToday, spentMonth: paidMonth } =
          await spentInPolicyWindows(agent.user_id);
        policyCheck = checkPolicy(
          agent,
          policy,
          paymentRequest,
          merchant,
          paidToday,
          paidMonth,
        );
      }
      const firstPayment =
        agent.licence.clean_purchases === 0 &&
        ![...payments.values()].some(
          (item) => item.agentId === agent.agent_id && item.status === "paid",
        );
      if (firstPayment && policyCheck.result === "pass") {
        policyCheck = {
          ...policyCheck,
          result: "step_up",
          detail: {
            ...policyCheck.detail,
            reason: "first_payment_requires_number_match",
          },
        };
      }
      checks.push(policyCheck);
      let riskCheck: Check = { name: "risk", result: "skipped" };
      let riskSignals: { type: string; score: number; action: string }[] = [];
      if (!checks.some((check) => check.result === "deny")) {
        const duplicate = orderCommitted(
          paymentRequest.merchant_id,
          paymentRequest.order_id,
        );
        if (duplicate) {
          riskCheck = {
            name: "risk",
            result: "deny",
            detail: { reason: "duplicate_order" },
          };
        } else {
          try {
            const assessment = await deps.assessRisk({
              agent,
              mandate,
              merchant,
              paymentRequest,
              priceEvidence: body.price_evidence,
              historyKnown:
                riskHistoryKnownAgents.has(agent.agent_id) && !paidWithoutTime,
              earlierPaidOrdersHour,
              earlierPaymentAttemptsHour,
              ownerAutoApproveBelow: policy.auto_approve_below.amount,
            });
            if (!["pass", "step_up", "deny"].includes(assessment.result))
              throw new Error("Invalid risk result");
            riskSignals = assessment.signals;
            riskCheck = {
              name: "risk",
              result: assessment.result,
              detail: {
                explanation: assessment.explanation,
                ...(assessment.result === "deny" &&
                assessment.signals.some((signal) => signal.type === "velocity")
                  ? { reason: "velocity_blocked" }
                  : {}),
              },
              signals: assessment.signals.map((signal) => signal.type),
            };
          } catch {
            riskCheck = {
              name: "risk",
              result: "step_up",
              detail: { reason: "risk_unavailable" },
            };
          }
        }
      }
      checks.push(riskCheck);
      let guardianCheck: Check = { name: "guardian", result: "skipped" };
      let guardianExplanation = "All verified checks passed.";
      if (!checks.some((check) => check.result === "deny")) {
        const shouldRun =
          composite ||
          agent.licence.level === "GREEN" ||
          mandate.intent_level !== "listing" ||
          riskCheck.result === "step_up" ||
          riskSignals.length > 0;
        if (shouldRun) {
          const input = GuardianInputSchema.parse({
            mandate: {
              intent_level: mandate.intent_level,
              description: mandate.description,
              user_text: mandate.user_text,
              user_text_source: mandate.user_text_source,
              constraints: mandate.constraints,
            },
            merchant_verified: {
              name: merchant.name,
              category: merchant.category,
              first_seen: merchant.first_seen,
            },
            signed_line_items: paymentRequest.line_items,
            deterministic_results: checks,
            untrusted: {
              cart_claim: body.cart_claim ?? [],
              rationale: body.rationale,
              price_evidence: body.price_evidence,
            },
            risk_signals: riskSignals,
          });
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              deps.evaluateGuardian(input),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Guardian timeout")),
                  guardianTimeoutMs,
                );
                timer.unref();
              }),
            ]);
            const verdict = GuardianVerdictSchema.parse(result);
            if (
              (verdict.verdict === "deny" &&
                verdict.reason_code !== "intent_mismatch" &&
                verdict.reason_code !== "other") ||
              (verdict.verdict !== "deny" && verdict.reason_code !== "none")
            )
              throw new Error("Unclassified Guardian verdict");
            guardianCheck = {
              name: "guardian",
              result: verdict.verdict,
              detail: {
                explanation: verdict.user_explanation,
                ...(verdict.verdict === "deny"
                  ? { reason: verdict.reason_code }
                  : {}),
                ...(verdict.verdict === "step_up" &&
                verdict.reasons.includes("guardian_unavailable")
                  ? { reason: "guardian_unavailable" }
                  : {}),
              },
            };
            guardianExplanation = verdict.user_explanation;
          } catch {
            guardianCheck = {
              name: "guardian",
              result: "step_up",
              detail: {
                reason: "guardian_unavailable",
                explanation:
                  "We could not confirm the purchase intent. Please review it.",
              },
            };
            guardianExplanation =
              "We could not confirm the purchase intent. Please review it.";
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }
      checks.push(guardianCheck);
      if (composite && !checks.some((check) => check.result === "deny")) {
        if (!deps.preflightPayment) {
          usedMerchantNonces.delete(nonceKey);
          mandate.in_flight_payment_id = null;
          return error("chain_unavailable", 503);
        }
        try {
          await deps.preflightPayment({
            paymentId,
            mandate,
            request: paymentRequest,
            merchant,
          });
          railCheck.detail = { ...railCheck.detail, contract_simulated: true };
        } catch (failure) {
          const provenDenial =
            failure instanceof ChainRevertError
              ? contractPayDenial(failure.reason)
              : null;
          if (!provenDenial) {
            usedMerchantNonces.delete(nonceKey);
            mandate.in_flight_payment_id = null;
            return error("chain_unavailable", 503);
          }
          railCheck.result = "deny";
          railCheck.detail = {
            ...railCheck.detail,
            reason: provenDenial.checkReason,
            contract_simulated: true,
          };
        }
      }
      const result = strictest(
        checks
          .filter((check) => check.result !== "skipped")
          .map((check) => check.result as Result),
      );
      const outcome =
        result === "deny"
          ? "DENIED"
          : result === "step_up" ||
              agent.licence.level !== "GREEN" ||
              guardianCheck.result !== "pass"
            ? "STEP_UP"
            : "APPROVED";
      const deniedReason = checks.find((check) => check.result === "deny")
        ?.detail?.reason;
      if (merchant.honeypot && activeDrill) {
        await recordTrustEvent(
          agent,
          "drill_failed",
          `${activeDrill.drillId}:${paymentRequest.merchant_id}:${paymentRequest.order_id}`,
          "Verified active fire-drill decoy payment attempt",
          "RED",
        );
      } else if (
        result === "deny" &&
        (mandateCheck.result === "deny" || policyCheck.result === "deny")
      ) {
        await flagTrust(
          agent,
          `payment:${paymentRequest.merchant_id}:${paymentRequest.order_id}`,
          `Verified payment outside mandate or hard policy: ${String(deniedReason ?? "denied")}`,
        );
      }
      const explanation =
        outcome === "DENIED"
          ? guardianCheck.result === "deny"
            ? denialFromChecks(checks).user_explanation
            : `Blocked by ${String(deniedReason ?? "verified policy")}.`
          : outcome === "STEP_UP"
            ? "Please review this payment in the WeBank app."
            : guardianExplanation;
      const decision = DecisionSchema.parse({
        schema: "decision.v1",
        decision_id: id("dec"),
        payment_id: paymentId,
        outcome,
        autonomy_level: agent.licence.level === "GREEN" ? "L1" : "L0",
        checks,
        risk_signals: riskSignals,
        user_explanation: explanation,
        created_at: now().toISOString(),
      });
      const payment: StoredPayment = {
        paymentId,
        ...(composite ? { paymentUri: body.payment_request } : {}),
        deployment: deps.stateContext,
        mandateId: mandate.mandate_id,
        agentId: agent.agent_id,
        userId: agent.user_id,
        merchant,
        request: paymentRequest,
        decision,
        status: "awaiting_user",
        createdAt: now().toISOString(),
      };
      payments.set(paymentId, payment);
      if (outcome === "DENIED") {
        const denied = await settle(payment, "DENIED", explanation);
        if (composite && denied.statusCode < 500) mandate.status = "cancelled";
        return denied;
      }
      if (outcome === "APPROVED") {
        if (composite) {
          mandate.status = "active";
          mandate.approved_by = "auto_threshold";
          let reserved = false;
          try {
            reserved = await deps.reserveMandate(mandate);
          } catch {
            /* fail closed */
          }
          if (!reserved) {
            mandate.status = "pending_checkout";
            mandate.approved_by = null;
            payment.status = "denied";
            mandate.in_flight_payment_id = null;
            return agentDenied("insufficient_reserved_funds");
          }
          try {
            await writeAudit({
              kind: "mandate",
              actor: agent.agent_id,
              subjectId: mandate.mandate_id,
              summary: "Green owner-threshold checkout activation",
              data: { mandate, payment_id: paymentId, decision },
            });
          } catch {
            await deps.releaseMandate(mandate);
            mandate.status = "pending_checkout";
            mandate.approved_by = null;
            payment.status = "reconciliation_required";
            return error("policy_denied", 503);
          }
        }
        payment.approvalSource = "auto";
        return settle(payment, "APPROVED", explanation);
      }
      const requestNumber = firstPayment
        ? randomInt(0, 1_000_000).toString().padStart(6, "0")
        : undefined;
      const cardLines = [
        `To: ${merchant.legal_name} (${merchant.uscc})`,
        `For: ${paymentRequest.line_items
          .filter((item) => item.type === "product")
          .map((item) => `${item.qty} x ${item.name} (${item.variant})`)
          .join(", ")}`,
        `Delivery: ${(paymentRequest.line_items.find((item) => item.type === "shipping")?.unit_price.amount ?? 0) / 100} ${paymentRequest.amount.currency}`,
        `Why asking: ${checks
          .filter((check) => check.result === "step_up")
          .map((check) => check.name)
          .join(", ")}`,
      ];
      const card = composite
        ? compositePaymentCard(
            agent,
            mandate,
            payment,
            body.payment_request,
            cardLines,
            firstPayment,
          )
        : approvalCard(
            "payment",
            firstPayment ? "zero_trust" : "everyday",
            paymentId,
            `${agent.display_name} wants to pay ${paymentRequest.amount.amount / 100} ${paymentRequest.amount.currency}`,
            cardLines,
            {
              paymentId,
              mandateId: mandate.mandate_id,
              paymentRequest,
              decision,
            },
          );
      payment.approvalId = card.approval_id;
      storeApproval({
        card,
        userId: agent.user_id,
        paymentId,
        requestNumber,
        numberMismatches: 0,
      });
      await writeAudit({
        kind: "payment_decision",
        actor: agent.agent_id,
        subjectId: decision.decision_id,
        summary: `STEP_UP ${paymentRequest.amount.amount} ${paymentRequest.amount.currency} to ${merchant.name}`,
        data: {
          decision,
          merchant_id: merchant.merchant_id,
          order_id: paymentRequest.order_id,
        },
      });
      return {
        statusCode: 202,
        body: {
          payment_id: paymentId,
          status: "awaiting_user",
          decision,
          approval_id: card.approval_id,
          level: card.level,
          expires_at: card.expires_at,
          approval_level: card.level,
          poll_after: 3,
          ...(requestNumber ? { request_number: requestNumber } : {}),
        },
      };
    } catch {
      const stored = payments.get(paymentId);
      if (stored) stored.status = "reconciliation_required";
      else if (mandate.in_flight_payment_id === paymentId)
        mandate.in_flight_payment_id = null;
      throw new Error("Payment processing failed closed");
    }
  }

  async function createMandate(agent: Agent, raw: unknown): Promise<Response> {
    const blocked = await policyGuard(agent.user_id);
    if (blocked) return blocked;
    if (deps.walletFunding && balanceChangePending(agent.user_id))
      return error("reconciliation_required", 503);
    const parsed = CreateMandateRequestSchema.safeParse(raw);
    if (!parsed.success) return error("invalid_mandate", 400);
    const policy = policies.get(agent.user_id);
    if (!policy) return error("policy_denied", 503);
    const constraints = parsed.data.constraints;
    const budget = constraints.find((item) => item.type === "budget");
    const amountRange = constraints.find(
      (item) => item.type === "amount_range",
    );
    const recurrence = constraints.find((item) => item.type === "recurrence");
    const window = constraints.find((item) => item.type === "execution_window");
    const categories = constraints.find((item) => item.type === "categories");
    if (!budget || !amountRange || !recurrence || !window || !categories)
      return error("invalid_mandate", 400);
    if (
      budget.max.currency !== policy.per_payment_max.currency ||
      amountRange.max.currency !== policy.per_payment_max.currency ||
      Date.parse(window.not_after) <= now().getTime()
    )
      return error("invalid_mandate", 400);
    if (mandateIntentLevel(constraints) !== parsed.data.intent_level)
      return error("invalid_mandate", 400);
    if (amountRange.max.amount > policy.per_payment_max.amount)
      return agentDenied("over_per_payment_cap", {
        requested_fen: amountRange.max.amount,
        cap_fen: policy.per_payment_max.amount,
      });
    if (budget.max.amount > policy.monthly_max.amount)
      return agentDenied("over_monthly_cap", {
        requested_fen: budget.max.amount,
        cap_fen: policy.monthly_max.amount,
      });
    const blockedCategory = categories.allowed.find((category) =>
      policy.blocked_categories.includes(category),
    );
    if (blockedCategory)
      return agentDenied("category_blocked", { category: blockedCategory });
    if (deps.walletFunding) {
      let walletBalance: number;
      try {
        const snapshot = await deps.walletFunding.snapshot();
        if (snapshot.walletFrozen) return error("policy_denied", 403);
        walletBalance = safeFen(snapshot.walletBalance);
      } catch {
        return error("chain_unavailable", 503);
      }
      if (
        walletBalance - reservedWalletFunds(agent.user_id) <
        budget.max.amount
      )
        return agentDenied("insufficient_reserved_funds");
    }
    const autoCap =
      agent.licence.level === "GREEN" ? policy.auto_approve_below.amount : 0;
    const oneTime =
      recurrence.frequency === "NONE" && recurrence.max_occurrences === 1;
    const approvalTiming =
      parsed.data.approval_timing ?? (oneTime ? "payment" : "upfront");
    if (approvalTiming === "payment" && !oneTime)
      return error("invalid_mandate", 400);
    const auto =
      approvalTiming === "upfront" &&
      autoCap > 0 &&
      budget.max.amount <= autoCap &&
      amountRange.max.amount <= autoCap &&
      recurrence.max_occurrences === 1;
    const mandateId = id("mdt");
    const mandateResult = MandateSchema.safeParse({
      schema: "mandate.v1",
      mandate_id: mandateId,
      agent_id: agent.agent_id,
      agent_key_binding: agent.public_key,
      description: parsed.data.description,
      intent_level: parsed.data.intent_level,
      approval_timing: approvalTiming,
      user_text: parsed.data.user_text,
      user_text_source: "agent_reported",
      constraints,
      status:
        approvalTiming === "payment"
          ? "pending_checkout"
          : auto
            ? "active"
            : "pending_user",
      spent: { amount: 0, currency: budget.max.currency },
      occurrences: 0,
      in_flight_payment_id: null,
      approved_by: auto ? "auto_threshold" : null,
      created_at: now().toISOString(),
    });
    if (!mandateResult.success) return error("invalid_mandate", 400);
    const mandate = mandateResult.data;
    if (approvalTiming === "payment") {
      mandates.set(mandateId, mandate);
      return {
        statusCode: 201,
        body: CreateMandateResponseSchema.parse({ mandate }),
      };
    }
    if (auto) {
      let reserved: boolean;
      try {
        reserved = await deps.reserveMandate(mandate);
      } catch {
        return error("chain_unavailable", 503);
      }
      if (!reserved) return agentDenied("insufficient_reserved_funds");
      try {
        await writeAudit({
          kind: "mandate",
          actor: agent.agent_id,
          subjectId: mandateId,
          summary: `Auto-threshold mandate for ${budget.max.amount} ${budget.max.currency}`,
          data: mandate,
        });
      } catch {
        await deps.releaseMandate(mandate);
        return error("policy_denied", 503);
      }
      mandates.set(mandateId, mandate);
      return {
        statusCode: 201,
        body: CreateMandateResponseSchema.parse({ mandate }),
      };
    }
    const firstMandate =
      agent.licence.level === "AMBER" &&
      ![...mandates.values()].some(
        (item) => item.agent_id === agent.agent_id && item.approved_by !== null,
      );
    const level = firstMandate ? "zero_trust" : "everyday";
    const requestNumber = firstMandate
      ? randomInt(0, 1_000_000).toString().padStart(6, "0")
      : undefined;
    const card = approvalCard(
      "mandate",
      level,
      mandateId,
      `${agent.display_name} requests a spending mandate`,
      [
        `User request (agent-reported until approved): ${parsed.data.user_text}`,
        `Agent summary: ${parsed.data.description}`,
        `Maximum reserved budget: ${budget.max.amount / 100} ${budget.max.currency}`,
        `Lock level: ${mandate.intent_level}`,
        `Expires: ${window.not_after}`,
        ...constraints.map(
          (constraint) => `Requested constraint: ${canonicalJson(constraint)}`,
        ),
      ],
      {
        mandateId,
        agentId: agent.agent_id,
        description: parsed.data.description,
        userText: parsed.data.user_text,
        constraints,
      },
    );
    mandates.set(mandateId, mandate);
    storeApproval({
      card,
      userId: agent.user_id,
      mandateId,
      requestNumber,
      numberMismatches: 0,
    });
    return {
      statusCode: 202,
      body: CreateMandateResponseSchema.parse({
        mandate,
        approval_id: card.approval_id,
        level: card.level,
        expires_at: card.expires_at,
        ...(requestNumber ? { request_number: requestNumber } : {}),
      }),
    };
  }

  async function decideApproval(
    userId: string,
    approvalId: string,
    raw: unknown,
  ): Promise<Response> {
    const parsed = ApprovalDecisionRequestSchema.safeParse(raw);
    if (!parsed.success) return error("policy_denied", 400);
    const entry = approvals.get(approvalId);
    if (!entry || entry.userId !== userId) return error("policy_denied", 403);
    if (entry.paymentId) {
      const uncertain = payments.get(entry.paymentId);
      if (
        uncertain?.status === "reconciliation_required" ||
        uncertain?.status === "settling"
      )
        return reconciliationError(uncertain);
    }
    await expireApproval(entry);
    if (entry.card.status !== "pending") return error("policy_denied", 403);
    if (parsed.data.decision === "reject") {
      entry.card.status = "rejected";
      emitEvent(userId, "approval.resolved", {
        approval_id: entry.card.approval_id,
        status: "rejected",
      });
      if (entry.mandateId) {
        const mandate = mandates.get(entry.mandateId);
        if (mandate) mandate.status = "cancelled";
      }
      if (entry.paymentId) {
        const payment = payments.get(entry.paymentId);
        if (payment)
          await settle(
            payment,
            "DENIED",
            "You rejected the payment in the WeBank app.",
            "user_rejected",
          );
      }
      return { statusCode: 200, body: { approval: entry.card } };
    }
    const blocked = await policyGuard(userId);
    if (blocked) return blocked;
    if (!demoProofAvailable) return error("policy_denied", 503);
    if (parsed.data.verification?.action_hash !== entry.card.payload_hash)
      return error("bad_signature", 401);
    const suppliedNumber = parsed.data.verification?.request_number;
    if (entry.card.level === "zero_trust") {
      if (suppliedNumber !== entry.requestNumber) {
        entry.numberMismatches++;
        if (entry.numberMismatches >= 3) {
          entry.card.status = "rejected";
          emitEvent(userId, "approval.resolved", {
            approval_id: entry.card.approval_id,
            status: "rejected",
          });
          if (entry.paymentId) {
            const payment = payments.get(entry.paymentId);
            if (payment) {
              await settle(
                payment,
                "DENIED",
                "Three incorrect request numbers cancelled this payment.",
              );
              await deps.recordNumberMatchFailure(
                payment.agentId,
                entry.card.approval_id,
              );
            }
          }
          if (entry.mandateId) {
            const mandate = mandates.get(entry.mandateId);
            if (mandate) {
              mandate.status = "cancelled";
              await deps.recordNumberMatchFailure(
                mandate.agent_id,
                entry.card.approval_id,
              );
            }
          }
        }
        return error("bad_signature", 401);
      }
    } else if (suppliedNumber !== undefined) {
      return error("bad_signature", 401);
    }
    const verifiedBy = await verifyDemoProof(
      entry.card,
      parsed.data.verification,
      userId,
    );
    if (!verifiedBy) return error("bad_signature", 401);
    await expireApproval(entry);
    if (entry.card.status !== "pending") return error("policy_denied", 403);
    if (entry.paymentId) {
      const payment = payments.get(entry.paymentId);
      if (payment?.review) {
        if (deps.walletFunding && balanceChangePending(userId))
          return error("reconciliation_required", 503);
        const mandate = mandates.get(payment.mandateId);
        if (
          !mandate ||
          payment.status !== "awaiting_user" ||
          !compositeReviewStillMatches(entry, payment, mandate)
        )
          return error("action_changed", 409);
        const agent = agents.get(payment.agentId);
        const policy = policies.get(userId);
        const merchant = await deps.lookupMerchant(
          payment.merchant.merchant_id,
        );
        const { spentToday, spentMonth } = await spentInPolicyWindows(userId);
        if (
          agent?.status !== "active" ||
          replacingAgents.has(payment.agentId) ||
          agent.licence.level === "RED" ||
          trustPending.has(payment.agentId) ||
          !policy ||
          !merchant ||
          merchant.public_key !== payment.merchant.public_key ||
          merchant.payout !== payment.merchant.payout ||
          merchant.legal_name !== payment.merchant.legal_name ||
          merchant.uscc !== payment.merchant.uscc ||
          merchant.honeypot ||
          Date.parse(payment.request.expires_at) <= now().getTime() ||
          orderCommitted(
            payment.request.merchant_id,
            payment.request.order_id,
            payment.paymentId,
          ) ||
          (
            await checkVerifiedMandateProduct(
              mandate,
              payment.request,
              merchant,
              true,
            )
          ).result === "deny" ||
          checkPolicy(
            agent,
            policy,
            payment.request,
            merchant,
            spentToday,
            spentMonth,
          ).result === "deny"
        ) {
          entry.card.status = "rejected";
          await settle(
            payment,
            "DENIED",
            "The checkout or wallet rules changed before approval.",
          );
          return error("policy_denied", 403, payment.decision.decision_id);
        }
        if (!deps.preflightPayment) return error("chain_unavailable", 503);
        try {
          await deps.preflightPayment({
            paymentId: payment.paymentId,
            mandate,
            request: payment.request,
            merchant: payment.merchant,
          });
        } catch (failure) {
          const provenDenial =
            failure instanceof ChainRevertError
              ? contractPayDenial(failure.reason)
              : null;
          if (!provenDenial) return error("chain_unavailable", 503);
          recordContractDenial(payment, provenDenial.checkReason);
          entry.card.status = "rejected";
          emitEvent(userId, "approval.resolved", {
            approval_id: entry.card.approval_id,
            status: "rejected",
          });
          const denied = await settle(
            payment,
            "DENIED",
            denial(provenDenial.rule).user_explanation,
            provenDenial.rule,
          );
          if (denied.statusCode >= 500) return denied;
          return agentDenied(provenDenial.rule);
        }
        mandate.status = "active";
        mandate.approved_by = verifiedBy;
        mandate.user_text_source = "webank_screen";
        let reserved: boolean;
        try {
          reserved = await deps.reserveMandate(mandate);
        } catch {
          mandate.status = "pending_checkout";
          mandate.approved_by = null;
          mandate.user_text_source = "agent_reported";
          return error("chain_unavailable", 503);
        }
        if (!reserved) {
          mandate.status = "pending_checkout";
          mandate.approved_by = null;
          mandate.user_text_source = "agent_reported";
          const denied = await settle(
            payment,
            "DENIED",
            "The Agent Wallet does not have enough unreserved funds.",
            "insufficient_reserved_funds",
          );
          if (denied.statusCode >= 500) return denied;
          entry.card.status = "rejected";
          emitEvent(userId, "approval.resolved", {
            approval_id: entry.card.approval_id,
            status: "rejected",
          });
          return agentDenied("insufficient_reserved_funds");
        }
        try {
          await writeAudit({
            kind: "mandate",
            actor: userId,
            subjectId: mandate.mandate_id,
            summary: "Owner-approved checkout-bound mandate activated",
            data: {
              mandate,
              original_intent_hash:
                payment.review.mandate_snapshot.canonical_hash,
              approval_id: entry.card.approval_id,
              approval_payload_hash: entry.card.payload_hash,
              payment_id: payment.paymentId,
            },
          });
        } catch {
          await deps.releaseMandate(mandate);
          mandate.status = "pending_checkout";
          mandate.approved_by = null;
          mandate.user_text_source = "agent_reported";
          return error("policy_denied", 503);
        }
      }
    }
    if (entry.mandateId) {
      if (deps.walletFunding && balanceChangePending(userId))
        return error("reconciliation_required", 503);
      const mandate = mandates.get(entry.mandateId);
      if (mandate?.status !== "pending_user")
        return error("mandate_not_found", 403);
      const window = mandate.constraints.find(
        (constraint) => constraint.type === "execution_window",
      );
      if (!window || Date.parse(window.not_after) <= now().getTime()) {
        mandate.status = "expired";
        entry.card.status = "expired";
        return error("mandate_expired", 403);
      }
      mandate.status = "active";
      mandate.approved_by = verifiedBy;
      mandate.user_text_source = "webank_screen";
      entry.card.status = "approved";
      let reserved: boolean;
      try {
        reserved = await deps.reserveMandate(mandate);
      } catch {
        mandate.status = "pending_user";
        mandate.approved_by = null;
        mandate.user_text_source = "agent_reported";
        entry.card.status = "pending";
        return error("chain_unavailable", 503);
      }
      if (!reserved) {
        mandate.status = "cancelled";
        mandate.approved_by = null;
        mandate.user_text_source = "agent_reported";
        entry.card.status = "rejected";
        emitEvent(userId, "approval.resolved", {
          approval_id: entry.card.approval_id,
          status: "rejected",
        });
        emitEvent(userId, "mandate.cancelled", {
          mandate_id: mandate.mandate_id,
          reason: "insufficient_reserved_funds",
        });
        return agentDenied("insufficient_reserved_funds");
      }
      try {
        await writeAudit({
          kind: "mandate",
          actor: userId,
          subjectId: mandate.mandate_id,
          summary: "User-confirmed mandate activated",
          data: mandate,
        });
      } catch {
        await deps.releaseMandate(mandate);
        mandate.status = "pending_user";
        mandate.approved_by = null;
        mandate.user_text_source = "agent_reported";
        entry.card.status = "pending";
        return error("policy_denied", 503);
      }
      emitEvent(userId, "approval.resolved", {
        approval_id: entry.card.approval_id,
        status: "approved",
      });
      return {
        statusCode: 200,
        body: { approval: entry.card, mandate: MandateSchema.parse(mandate) },
      };
    }
    if (entry.paymentId) {
      const payment = payments.get(entry.paymentId);
      if (payment?.status !== "awaiting_user")
        return error("policy_denied", 403);
      if (
        orderCommitted(
          payment.request.merchant_id,
          payment.request.order_id,
          payment.paymentId,
        )
      ) {
        entry.card.status = "rejected";
        await settle(
          payment,
          "DENIED",
          "This merchant order is already being paid.",
          "duplicate_payment",
        );
        return agentDenied("duplicate_payment");
      }
      const agent = agents.get(payment.agentId);
      const mandate = mandates.get(payment.mandateId);
      const policy = policies.get(userId);
      const merchant = await deps.lookupMerchant(payment.merchant.merchant_id);
      if (
        agent?.status !== "active" ||
        agent.licence.level === "RED" ||
        trustPending.has(payment.agentId) ||
        !mandate ||
        mandate.status !== "active" ||
        !policy ||
        !merchant ||
        merchant.public_key !== payment.merchant.public_key ||
        merchant.honeypot ||
        checkMandate(mandate, payment.request, merchant, now()).result ===
          "deny"
      ) {
        entry.card.status = "rejected";
        await settle(
          payment,
          "DENIED",
          "The mandate or merchant changed before approval.",
        );
        return error("policy_denied", 403, payment.decision.decision_id);
      }
      const { spentToday, spentMonth } = await spentInPolicyWindows(userId);
      if (
        checkPolicy(
          agent,
          policy,
          payment.request,
          merchant,
          spentToday,
          spentMonth,
        ).result === "deny"
      ) {
        entry.card.status = "rejected";
        await settle(
          payment,
          "DENIED",
          "Your current policy blocks this payment.",
        );
        return error("policy_denied", 403, payment.decision.decision_id);
      }
      entry.card.status = "approved";
      payment.approvalSource = "owner";
      const response = await settle(
        payment,
        "APPROVED",
        verifiedBy === "demo_simulation"
          ? "Local demo approval simulation accepted this verified payment."
          : "You approved this verified payment in the WeBank app.",
      );
      emitEvent(userId, "approval.resolved", {
        approval_id: entry.card.approval_id,
        status: "approved",
      });
      if (response.statusCode !== 200) return response;
      return {
        statusCode: 200,
        body: { approval: entry.card, payment: response.body },
      };
    }
    return error("policy_denied", 403);
  }

  function send(
    reply: { code(status: number): { send(body: unknown): unknown } },
    response: Response,
  ) {
    return reply.code(response.statusCode).send(response.body);
  }

  app.post("/v1/oauth/device_authorization", async (request, reply) => {
    const parsed = DeviceAuthorizationRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_request" });
    if (
      parsed.data.client_app_id !==
      `app_${createHash("sha256").update(parsed.data.client_app_name, "utf8").digest("hex")}`
    )
      return reply.code(400).send({ error: "invalid_request" });
    let keyValid = false;
    try {
      const key = createPublicKey({
        key: Buffer.from(parsed.data.agent_public_key.slice(5), "base64url"),
        format: "der",
        type: "spki",
      });
      keyValid =
        key.asymmetricKeyType === "ec" &&
        key.asymmetricKeyDetails?.namedCurve === "prime256v1";
    } catch {
      keyValid = false;
    }
    if (!keyValid) return reply.code(400).send({ error: "invalid_request" });
    const deviceCode = randomBytes(32).toString("base64url");
    let userCode = "";
    do {
      const code = randomBytes(4).toString("hex").toUpperCase();
      userCode = `${code.slice(0, 4)}-${code.slice(4)}`;
    } while (pairingByUserCode.has(userCode));
    const requestNumber = randomInt(0, 1_000_000).toString().padStart(6, "0");
    const base =
      deps.verificationUriBase ?? "http://127.0.0.1:3002/v1/app/pairing";
    const verificationUri = new URL(base).toString();
    const qrPayload = new URL(
      `${base.replace(/\/$/, "")}/${userCode}`,
    ).toString();
    const card = approvalCard(
      "pairing",
      "zero_trust",
      userCode,
      "Connect an agent to WeBank",
      [
        `Agent request: ${parsed.data.client_name}`,
        `Provider claim: ${parsed.data.provider}`,
        `Client app: ${parsed.data.client_app_name}`,
        `Client app ID: ${parsed.data.client_app_id}`,
        `Requested scopes: ${parsed.data.requested_scopes.join(", ")}`,
        `Public key: ${parsed.data.agent_public_key}`,
      ],
      {
        userCode,
        client_name: parsed.data.client_name,
        provider: parsed.data.provider,
        client_app_id: parsed.data.client_app_id,
        client_app_name: parsed.data.client_app_name,
        agent_public_key: parsed.data.agent_public_key,
        requested_scopes: parsed.data.requested_scopes,
      },
      600,
    );
    const pairing: PairingEntry = {
      deviceCode,
      userCode,
      requestNumber,
      card,
      clientName: parsed.data.client_name,
      provider: parsed.data.provider,
      clientAppId: parsed.data.client_app_id,
      clientAppName: parsed.data.client_app_name,
      publicKey: parsed.data.agent_public_key,
      scopes: parsed.data.requested_scopes,
      expiresAt: now().getTime() + 600_000,
      status: "pending",
      mismatches: 0,
      requestNumberExpiresAt: now().getTime() + 180_000,
      replacementAgentId: null,
      replacementResolved: true,
    };
    pairingByDevice.set(deviceCode, pairing);
    pairingByUserCode.set(userCode, pairing);
    return reply.send(
      DeviceAuthorizationResponseSchema.parse({
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: verificationUri,
        qr_payload: qrPayload,
        request_number: requestNumber,
        request_number_expires_at: new Date(
          pairing.requestNumberExpiresAt,
        ).toISOString(),
        expires_in: 600,
        interval: 3,
      }),
    );
  });

  app.post("/v1/oauth/token", async (request, reply) => {
    const parsed = TokenRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "invalid_request" });
    if (parsed.data.grant_type === "refresh_token") {
      const agentId = agentAuth.refreshAgentId(
        parsed.data.refresh_token,
        now().getTime(),
      );
      const agent = agentId ? agents.get(agentId) : null;
      if (
        agent?.status !== "active" ||
        agent.deleted_at ||
        agent.licence.level === "RED"
      )
        return reply.code(400).send({ error: "invalid_grant" });
      if (idleRequired(agent))
        return send(reply, error("reauthorization_required", 401));
      const rotated = agentAuth.rotate(
        parsed.data.refresh_token,
        now().getTime(),
      );
      if (!rotated) return reply.code(400).send({ error: "invalid_grant" });
      return reply.send(TokenResponseSchema.parse(rotated));
    }
    const pairing = pairingByDevice.get(parsed.data.device_code);
    if (
      !pairing ||
      pairing.expiresAt <= now().getTime() ||
      pairing.status === "consumed"
    )
      return reply
        .code(400)
        .send(DeviceTokenErrorSchema.parse({ error: "expired_token" }));
    if (pairing.status === "denied")
      return reply
        .code(400)
        .send(DeviceTokenErrorSchema.parse({ error: "access_denied" }));
    if (pairing.status !== "approved" || !pairing.agentId)
      return reply
        .code(400)
        .send(DeviceTokenErrorSchema.parse({ error: "authorization_pending" }));
    pairing.status = "consumed";
    return reply.send(
      TokenResponseSchema.parse(
        agentAuth.issue(pairing.agentId, now().getTime()),
      ),
    );
  });

  app.get("/v1/agent/session", async (request, reply) => {
    const deviceCode = request.headers.authorization?.match(
      /^Device ([A-Za-z0-9_-]+)$/,
    )?.[1];
    if (deviceCode) {
      const pairing = pairingByDevice.get(deviceCode);
      if (!pairing) return send(reply, error("bad_signature", 401));
      rotatePairingNumber(pairing);
      return reply.send({
        state:
          pairingStatus(pairing) === "expired"
            ? "pairing_expired"
            : pairingStatus(pairing) === "rejected"
              ? "not_paired"
              : "pairing_pending",
        pairing: {
          user_code: pairing.userCode,
          expires_at: new Date(pairing.expiresAt).toISOString(),
          request_number_expires_at: new Date(
            pairing.requestNumberExpiresAt,
          ).toISOString(),
        },
      });
    }
    const auth = agentAuth.verify(
      request,
      Buffer.alloc(0),
      agents,
      now().getTime(),
      true,
    );
    if ("error" in auth) return send(reply, error(auth.error, 401));
    const agent = auth.agent;
    const state =
      agent.status === "revoked" || agent.deleted_at
        ? "revoked"
        : agent.status === "frozen"
          ? "frozen"
          : agent.licence.level === "RED"
            ? "red"
            : idleRequired(agent)
              ? "reauthorization_required"
              : "connected";
    let accessTokenValid = agentAuth.hasAccess(
      request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1],
      agent.agent_id,
      now().getTime(),
    );
    if (deps.authenticateAgent) {
      try {
        accessTokenValid =
          (await deps.authenticateAgent(request))?.agent_id === agent.agent_id;
      } catch {
        accessTokenValid = false;
      }
    }
    return reply.send({
      state,
      agent_id: agent.agent_id,
      client_app_id: agent.client_app_id ?? null,
      client_app_name: agent.client_app_name ?? null,
      last_used_at: agent.last_used_at,
      idle_expires_at: idleExpiresAt(agent),
      access_token_valid: accessTokenValid,
      licence: agent.licence,
      active_mandates: [...mandates.values()]
        .filter(
          (item) =>
            item.agent_id === agent.agent_id && item.status === "active",
        )
        .map((item) => item.mandate_id),
    });
  });

  app.post("/v1/agent/session/renew", async (request, reply) => {
    if (request.headers.authorization)
      return send(reply, error("bad_signature", 401));
    if (
      !request.body ||
      typeof request.body !== "object" ||
      Array.isArray(request.body) ||
      Object.keys(request.body).length !== 0
    )
      return send(reply, error("invalid_request", 400));
    const auth = agentAuth.verify(
      request,
      rawBodies.get(request) ?? Buffer.alloc(0),
      agents,
      now().getTime(),
      true,
    );
    if ("error" in auth) return send(reply, error(auth.error, 401));
    const agent = auth.agent;
    if (
      agent.status !== "active" ||
      agent.deleted_at ||
      agent.licence.level === "RED" ||
      replacingAgents.has(agent.agent_id)
    )
      return send(reply, error("agent_frozen", 401));
    const renewal = idleRenewals.get(agent.agent_id);
    if (
      !renewal ||
      renewal.consumed ||
      renewal.expiresAt <= now().getTime() ||
      renewal.publicKey !== agent.public_key ||
      !idleRequired(agent)
    )
      return send(reply, error("action_changed", 409));
    const oldAuth = agentAuth.snapshot();
    const oldLastUsedAt = agent.last_used_at;
    renewal.consumed = true;
    agentAuth.revokeAgent(agent.agent_id);
    agent.last_used_at = now().toISOString();
    const tokens = TokenResponseSchema.parse(
      agentAuth.issue(agent.agent_id, now().getTime()),
    );
    try {
      persist();
    } catch (failure) {
      renewal.consumed = false;
      agent.last_used_at = oldLastUsedAt;
      agentAuth.restore(oldAuth);
      app.log.error(
        { err: failure, agentId: agent.agent_id },
        "Idle renewal persistence failed",
      );
      return send(reply, error("service_unavailable", 503));
    }
    emitEvent(agent.user_id, "agent.idle_reauthorized", {
      agent_id: agent.agent_id,
    });
    return reply.send(tokens);
  });

  app.post("/v1/agent/session/revoke", async (request, reply) => {
    const auth = agentAuth.verify(
      request,
      rawBodies.get(request) ?? Buffer.alloc(0),
      agents,
      now().getTime(),
      true,
    );
    if ("error" in auth) return send(reply, error(auth.error, 401));
    return send(
      reply,
      await idem(auth.agent.agent_id, request, () =>
        serializePaymentSubmission(auth.agent.user_id, async () => {
          const agent = auth.agent;
          const rePair =
            (request.body as { re_pair?: unknown } | null)?.re_pair === true;
          agent.status = "revoked";
          invalidateIdleRecovery(agent.agent_id);
          agentAuth.revokeAgent(agent.agent_id);
          if (!(await cancelRevokedAgentMandates(agent, "agent_disconnected")))
            return error("service_unavailable", 503);
          await writeAudit({
            kind: "freeze",
            actor: agent.user_id,
            subjectId: agent.agent_id,
            summary: "Agent disconnected its own key",
            data: { agent_id: agent.agent_id, re_pair: rePair },
          });
          emitEvent(agent.user_id, "agent.revoked", {
            agent_id: agent.agent_id,
          });
          return {
            statusCode: 200,
            body: { state: "revoked" },
          };
        }),
      ),
    );
  });

  app.get<{ Params: { deviceCode: string } }>(
    "/v1/oauth/device_authorization/:deviceCode",
    async (request, reply) => {
      const pairing = pairingByDevice.get(request.params.deviceCode);
      if (!pairing) return send(reply, error("bad_signature", 401));
      rotatePairingNumber(pairing);
      const wait = Math.min(
        55,
        Math.max(0, Number((request.query as { wait?: string }).wait ?? 0)),
      );
      const deadline = Date.now() + wait * 1000;
      const oldNumber = pairing.requestNumber;
      while (
        pairingStatus(pairing) === "pending" &&
        oldNumber === pairing.requestNumber &&
        Date.now() < deadline
      ) {
        await delay(Math.min(200, Math.max(1, deadline - Date.now())));
        rotatePairingNumber(pairing);
      }
      const status = pairingStatus(pairing);
      return reply.send({
        status:
          status === "pending"
            ? "still_pending"
            : status === "rejected"
              ? "rejected"
              : status,
        expires_at: new Date(pairing.expiresAt).toISOString(),
        ...(status === "pending"
          ? {
              request_number: pairing.requestNumber,
              request_number_expires_at: new Date(
                pairing.requestNumberExpiresAt,
              ).toISOString(),
            }
          : {}),
      });
    },
  );

  app.get<{ Params: { userCode: string } }>(
    "/v1/app/pairing/:userCode",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      const pairing = pairingByUserCode.get(request.params.userCode);
      if (
        !pairing ||
        pairing.expiresAt <= now().getTime() ||
        pairing.status !== "pending"
      )
        return send(reply, error("policy_denied", 403));
      if (pairing.userId && pairing.userId !== userId)
        return send(reply, error("policy_denied", 403));
      pairing.userId = userId;
      ensureIndependentPairing(pairing);
      return reply.send({
        approval: pairing.card,
        pairing: pairingSummary(pairing),
        public_key: pairing.publicKey,
        replacement_candidates: [],
        client_name: pairing.clientName,
        provider: pairing.provider,
        requested_scopes: pairing.scopes,
      });
    },
  );

  app.get("/v1/app/pairings", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    const requested = (request.query as { status?: string }).status;
    if (
      requested &&
      !["pending", "approved", "rejected", "expired"].includes(requested)
    )
      return send(reply, error("invalid_request", 400));
    const items = [...pairingByUserCode.values()]
      .filter((pairing) => pairing.userId === userId)
      .map(pairingSummary)
      .filter((pairing) => !requested || pairing.status === requested);
    return reply.send({ items, next_cursor: null });
  });

  app.post<{ Params: { userCode: string } }>(
    "/v1/app/pairing/:userCode/select-replacement",
    async (_request, reply) => send(reply, error("invalid_request", 410)),
  );

  app.post<{ Params: { userCode: string } }>(
    "/v1/app/pairing/:userCode/approve",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      return send(
        reply,
        await idem(userId, request, async () => {
          const pairing = pairingByUserCode.get(request.params.userCode);
          if (
            pairing?.status === "processing" &&
            pairing.userId === userId &&
            pairing.agentId
          ) {
            const recovering = agents.get(pairing.agentId);
            if (!recovering) return error("reconciliation_required", 503);
            try {
              await recordTrustEvent(
                recovering,
                "transition",
                `initial-amber:${pairing.deviceCode}`,
                "New paired agent registered Amber",
                "AMBER",
                true,
              );
              recovering.status = "active";
              riskHistoryKnownAgents.add(recovering.agent_id);
              pairing.status = "approved";
              pairing.card.status = "approved";
              persist();
              return { statusCode: 200, body: { agent: recovering } };
            } catch {
              return error("reconciliation_required", 503);
            }
          }
          if (
            !pairing ||
            pairing.expiresAt <= now().getTime() ||
            pairing.status !== "pending"
          )
            return error("policy_denied", 403);
          if (pairing.userId !== userId) return error("policy_denied", 403);
          if (!pairing.clientAppId || !pairing.clientAppName)
            return error("action_changed", 409);
          ensureIndependentPairing(pairing);
          if (!demoProofAvailable) return error("policy_denied", 503);
          const parsed = ApprovalDecisionRequestSchema.safeParse({
            decision: "approve",
            ...(request.body as object),
          });
          if (
            !parsed.success ||
            parsed.data.verification?.action_hash !== pairing.card.payload_hash
          )
            return error("bad_signature", 401);
          rotatePairingNumber(pairing);
          if (
            parsed.data.verification.request_number !== pairing.requestNumber
          ) {
            if (
              pairing.previousRequestNumber &&
              parsed.data.verification.request_number ===
                pairing.previousRequestNumber
            )
              return error("request_number_expired", 409);
            pairing.mismatches++;
            if (pairing.mismatches >= 3) {
              pairing.status = "denied";
              pairing.card.status = "rejected";
              emitEvent(userId, "approval.resolved", {
                approval_id: pairing.card.approval_id,
                status: "rejected",
              });
            }
            return error("bad_signature", 401);
          }
          const verified = await verifyDemoProof(
            pairing.card,
            parsed.data.verification,
            userId,
          );
          if (!verified) return error("bad_signature", 401);
          if (
            pairing.status !== "pending" ||
            pairing.expiresAt <= now().getTime()
          )
            return error("policy_denied", 403);
          pairing.status = "processing";
          const agentId = id("agt");
          const record = AgentSchema.parse({
            schema: "agent.v1",
            agent_id: agentId,
            user_id: userId,
            display_name: pairing.clientName,
            provider: pairing.provider,
            client_app_id: pairing.clientAppId,
            client_app_name: pairing.clientAppName,
            public_key: pairing.publicKey,
            scopes: pairing.scopes,
            licence: {
              level: "AMBER",
              clean_purchases: 0,
              drills_passed: 0,
              drills_failed: 0,
              flags_30d: 0,
              reason: "New agent, no history yet",
              updated_at: now().toISOString(),
            },
            status: "frozen",
            lineage: {
              root_agent_id: agentId,
              replaces_agent_id: null,
              replaced_by_agent_id: null,
            },
            deleted_at: null,
            created_at: now().toISOString(),
            last_used_at: now().toISOString(),
          });
          try {
            await writeAudit({
              kind: "pairing",
              actor: userId,
              subjectId: agentId,
              summary:
                verified === "demo_simulation"
                  ? `Local demo pairing simulation approved for ${pairing.clientName}`
                  : `Biometric pairing approved for ${pairing.clientName}`,
              data: {
                agent_id: agentId,
                key: pairing.publicKey,
                scopes: pairing.scopes,
                client_app_id: pairing.clientAppId,
                client_app_name: pairing.clientAppName,
                replaces_agent_id: null,
                prior_key_revoked: false,
              },
            });
          } catch (failure) {
            pairing.status = "pending";
            app.log.error(
              { err: failure, userCode: pairing.userCode },
              "Pairing audit anchor failed; pairing remains pending",
            );
            return error("service_unavailable", 503);
          }
          agents.set(agentId, record);
          pairing.agentId = agentId;
          persist();
          try {
            await recordTrustEvent(
              record,
              "transition",
              `initial-amber:${pairing.deviceCode}`,
              "New paired agent registered Amber",
              "AMBER",
              true,
            );
          } catch (failure) {
            app.log.error(
              { failure, userCode: pairing.userCode },
              "Initial Amber registry write requires reconciliation",
            );
            return error("service_unavailable", 503);
          }
          record.status = "active";
          riskHistoryKnownAgents.add(record.agent_id);
          pairing.status = "approved";
          pairing.card.status = "approved";
          emitEvent(userId, "approval.resolved", {
            approval_id: pairing.card.approval_id,
            status: "approved",
          });
          return { statusCode: 200, body: { agent: record } };
        }),
      );
    },
  );

  app.post<{ Params: { userCode: string } }>(
    "/v1/app/pairing/:userCode/deny",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      return send(
        reply,
        await idem(userId, request, async () => {
          const pairing = pairingByUserCode.get(request.params.userCode);
          if (
            !pairing ||
            pairing.expiresAt <= now().getTime() ||
            pairing.status !== "pending"
          )
            return error("policy_denied", 403);
          pairing.status = "denied";
          pairing.card.status = "rejected";
          emitEvent(userId, "approval.resolved", {
            approval_id: pairing.card.approval_id,
            status: "rejected",
          });
          return { statusCode: 200, body: { approval: pairing.card } };
        }),
      );
    },
  );

  app.post("/v1/agent/mandates", async (request, reply) => {
    const auth = await agentFor(request, "wallet:mandate");
    if (!auth.agent) return send(reply, auth.response as Response);
    return send(
      reply,
      await idem(auth.agent.agent_id, request, () =>
        serializePaymentSubmission(auth.agent.user_id, () =>
          createMandate(auth.agent, request.body),
        ),
      ),
    );
  });

  app.get<{ Params: { id: string } }>(
    "/v1/agent/mandates/:id",
    async (request, reply) => {
      const auth = await agentFor(request, "wallet:mandate");
      if (!auth.agent) return send(reply, auth.response as Response);
      await expireDueApprovals();
      const mandate = mandates.get(request.params.id);
      if (!mandate || mandate.agent_id !== auth.agent.agent_id)
        return send(reply, agentDenied("mandate_not_found"));
      const window = mandate.constraints.find(
        (constraint) => constraint.type === "execution_window",
      );
      const reported =
        (mandate.status === "active" ||
          mandate.status === "pending_checkout") &&
        window &&
        Date.parse(window.not_after) <= now().getTime()
          ? { ...mandate, status: "expired" as const }
          : mandate;
      return reply.send(MandateResponseSchema.parse({ mandate: reported }));
    },
  );

  app.post("/v1/agent/payments", async (request, reply) => {
    const auth = await agentFor(request, "wallet:pay");
    if (!auth.agent) return send(reply, auth.response as Response);
    return send(
      reply,
      await idem(auth.agent.agent_id, request, () =>
        serializePaymentSubmission(auth.agent.user_id, () =>
          submitPayment(auth.agent, request.body, request),
        ),
      ),
    );
  });

  app.get<{ Params: { id: string } }>(
    "/v1/agent/payments/:id",
    async (request, reply) => {
      const auth = await agentFor(request, "wallet:pay");
      if (!auth.agent) return send(reply, auth.response as Response);
      await expireDueApprovals();
      const payment = payments.get(request.params.id);
      if (!payment || payment.agentId !== auth.agent.agent_id)
        return send(reply, error("not_found", 404));
      if (
        payment.status === "reconciliation_required" ||
        payment.status === "settling"
      )
        return send(reply, reconciliationError(payment));
      return reply.send(
        PaymentStatusResponseSchema.parse({
          payment_id: payment.paymentId,
          status: payment.status,
          decision: payment.decision,
          ...(payment.receipt ? { receipt: payment.receipt } : {}),
          ...(payment.denialError ? { error: payment.denialError } : {}),
        }),
      );
    },
  );

  app.get("/v1/agent/payments", async (request, reply) => {
    const auth = await agentFor(request, "wallet:history:self");
    if (!auth.agent) return send(reply, auth.response as Response);
    const items = [...payments.values()]
      .filter((payment) => payment.agentId === auth.agent.agent_id)
      .filter(
        (payment) =>
          payment.status !== "reconciliation_required" &&
          payment.status !== "settling",
      )
      .map((payment) => ({
        payment_id: payment.paymentId,
        status: payment.status,
        amount: payment.request.amount,
        merchant: payment.merchant.name,
        created_at: payment.createdAt,
      }));
    return reply.send(
      PaymentHistoryResponseSchema.parse({ items, next_cursor: null }),
    );
  });

  app.get<{ Params: { id: string } }>(
    "/v1/agent/approvals/:id",
    async (request, reply) => {
      const auth = await agentFor(request, "wallet:history:self");
      if (!auth.agent) return send(reply, auth.response as Response);
      const entry = approvals.get(request.params.id);
      if (
        !entry ||
        (entry.mandateId &&
          mandates.get(entry.mandateId)?.agent_id !== auth.agent.agent_id) ||
        (entry.paymentId &&
          payments.get(entry.paymentId)?.agentId !== auth.agent.agent_id) ||
        (!entry.mandateId && !entry.paymentId)
      )
        return send(reply, error("not_found", 404));
      const wait = Math.min(
        55,
        Math.max(0, Number((request.query as { wait?: string }).wait ?? 0)),
      );
      const deadline = Date.now() + wait * 1000;
      await expireDueApprovals();
      while (entry.card.status === "pending" && Date.now() < deadline) {
        await delay(Math.min(200, Math.max(1, deadline - Date.now())));
        await expireDueApprovals();
      }
      return reply.send({
        approval_id: entry.card.approval_id,
        status:
          entry.card.status === "pending" ? "still_pending" : entry.card.status,
        expires_at: entry.card.expires_at,
        subject_id: entry.card.subject_id,
      });
    },
  );

  app.get("/v1/app/policy", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    const policy = policies.get(userId);
    if (!policy) return send(reply, error("not_found", 404));
    if (!deps.policyCaps)
      return reply.send({
        policy,
        policy_hash: policyHash(policy),
        contract: null,
        sync_status: "chain_unavailable",
      });
    try {
      const caps = await deps.policyCaps.read();
      return reply.send({
        policy,
        policy_hash: policyHash(policy),
        contract: capsPublic(caps),
        sync_status: policyChangePending(userId)
          ? "change_pending"
          : capsMatchPolicy(caps, policy)
            ? "consistent"
            : "mismatch",
      });
    } catch {
      return reply.send({
        policy,
        policy_hash: policyHash(policy),
        contract: null,
        sync_status: "chain_unavailable",
      });
    }
  });

  app.post("/v1/app/policy/prepare", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    return send(
      reply,
      await serializePaymentSubmission(userId, async () => {
        const policy = policies.get(userId);
        if (!policy || !deps.policyCaps || !walletDeployment)
          return error("chain_unavailable", 503);
        if (policyChangePending(userId))
          return error("reconciliation_required", 503);
        const body = request.body as Record<string, unknown> | null;
        const proposed = body?.proposed as Record<string, unknown> | null;
        if (
          !proposed ||
          typeof proposed !== "object" ||
          Array.isArray(proposed) ||
          Object.keys(proposed).sort().join(",") !==
            "auto_approve_below,daily_max,monthly_max,per_payment_max"
        )
          return error("invalid_request", 400);
        const next = PolicySchema.safeParse({ ...policy, ...proposed });
        if (!next.success) return error("invalid_request", 400);
        const limits: PolicyLimits = {
          per_payment_max: next.data.per_payment_max,
          daily_max: next.data.daily_max,
          monthly_max: next.data.monthly_max,
          auto_approve_below: next.data.auto_approve_below,
        };
        const {
          per_payment_max: per,
          daily_max: day,
          monthly_max: month,
          auto_approve_below: auto,
        } = limits;
        if (
          per.amount <= 0 ||
          per.amount > day.amount ||
          day.amount > month.amount ||
          auto.amount < 0 ||
          auto.amount > per.amount
        )
          return error("invalid_request", 400);
        let caps: PolicyCapsSnapshot;
        try {
          caps = await deps.policyCaps.read();
        } catch {
          return error("chain_unavailable", 503);
        }
        const baseCaps = {
          perPayment: safeFen(caps.perPaymentCap),
          daily: safeFen(caps.dailyCap),
          monthly: safeFen(caps.monthlyCap),
        };
        const expectedCaps = {
          per_payment_max: walletMoney(baseCaps.perPayment),
          daily_max: walletMoney(baseCaps.daily),
          monthly_max: walletMoney(baseCaps.monthly),
        };
        if (body?.expected_contract_caps === undefined)
          return error("invalid_request", 400);
        if (
          !capsMatchPolicy(caps, policy) ||
          body?.expected_policy_hash !== policyHash(policy) ||
          body?.expected_contract_block !== caps.blockNumber.toString() ||
          sha256(body?.expected_contract_caps) !== sha256(expectedCaps)
        )
          return error("action_changed", 409);
        const changeId = id("pch");
        const expiresAt = now().getTime() + 60_000;
        const sessionBinding = appSessionBinding(request);
        const actionHash = policyChangeHash({
          userId,
          sessionBinding,
          changeId,
          policyHash: policyHash(policy),
          baseCaps,
          baseBlock: caps.blockNumber.toString(),
          proposed: limits,
          deployment: walletDeployment,
          expiresAt,
        });
        policyChanges.set(changeId, {
          changeId,
          userId,
          sessionBinding,
          policyHash: policyHash(policy),
          baseCaps,
          baseBlock: caps.blockNumber.toString(),
          proposed: limits,
          actionHash,
          expiresAt,
          deployment: walletDeployment,
          status: "prepared",
        });
        persist();
        return {
          statusCode: 200,
          body: {
            change_id: changeId,
            action_hash: actionHash,
            expires_at: new Date(expiresAt).toISOString(),
            current: policy,
            proposed: limits,
            requires_verification:
              per.amount > policy.per_payment_max.amount ||
              day.amount > policy.daily_max.amount ||
              month.amount > policy.monthly_max.amount ||
              auto.amount > policy.auto_approve_below.amount,
            simulated: true,
          },
        };
      }),
    );
  });

  app.put("/v1/app/policy", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key || key.length > 255)
      return send(reply, error("idempotency_conflict", 409));
    return send(
      reply,
      await serializePaymentSubmission(userId, async () => {
        const body = request.body as {
          change_id?: unknown;
          verification?: { action_hash?: unknown; device_signature?: unknown };
        } | null;
        const change =
          typeof body?.change_id === "string"
            ? policyChanges.get(body.change_id)
            : undefined;
        if (!change || change.userId !== userId)
          return error("action_changed", 409);
        const keyId = `${userId}:policy:${key}`;
        const bodyHash = sha256(body);
        const oldKey = policyKeys.get(keyId);
        if (
          oldKey &&
          (oldKey.changeId !== change.changeId || oldKey.bodyHash !== bodyHash)
        )
          return error("idempotency_conflict", 409);
        if (change.status === "confirmed") {
          if (!oldKey) return error("action_changed", 409);
          const policy = policies.get(userId);
          if (!policy || !deps.policyCaps)
            return error("chain_unavailable", 503);
          try {
            const caps = await deps.policyCaps.read();
            if (!capsMatchPolicy(caps, policy))
              return error("reconciliation_required", 503);
            return {
              statusCode: 200,
              body: {
                policy,
                policy_hash: policyHash(policy),
                contract: capsPublic(caps),
                sync_status: "consistent",
              },
            };
          } catch {
            return error("chain_unavailable", 503);
          }
        }
        if (change.status === "prepared") {
          const policy = policies.get(userId);
          if (
            !policy ||
            !deps.policyCaps ||
            !walletDeployment ||
            change.expiresAt <= now().getTime() ||
            change.sessionBinding !== appSessionBinding(request) ||
            change.deployment !== walletDeployment ||
            change.actionHash !== policyChangeHash(change) ||
            change.policyHash !== policyHash(policy) ||
            policyChangePending(userId)
          )
            return error("action_changed", 409);
          let caps: PolicyCapsSnapshot;
          try {
            caps = await deps.policyCaps.read();
          } catch {
            return error("chain_unavailable", 503);
          }
          if (
            !capsMatchPolicy(caps, policy) ||
            caps.blockNumber.toString() !== change.baseBlock ||
            caps.perPaymentCap !== BigInt(change.baseCaps.perPayment) ||
            caps.dailyCap !== BigInt(change.baseCaps.daily) ||
            caps.monthlyCap !== BigInt(change.baseCaps.monthly)
          )
            return error("action_changed", 409);
          const loosened =
            change.proposed.per_payment_max.amount >
              policy.per_payment_max.amount ||
            change.proposed.daily_max.amount > policy.daily_max.amount ||
            change.proposed.monthly_max.amount > policy.monthly_max.amount ||
            change.proposed.auto_approve_below.amount >
              policy.auto_approve_below.amount;
          if (loosened) {
            if (body?.verification?.action_hash !== change.actionHash)
              return error("bad_signature", 401);
            const card = approvalCard(
              "policy_loosen",
              "everyday",
              change.changeId,
              "Change Agent Wallet limits",
              ["Confirm the exact new wallet limits"],
              { actionHash: change.actionHash },
            );
            card.payload_hash = change.actionHash;
            if (!(await verifyDemoProof(card, body.verification, userId)))
              return error("bad_signature", 401);
          }
          let audit: AuditRecord;
          try {
            audit = await writeAudit({
              kind: "policy_change",
              actor: userId,
              subjectId: change.changeId,
              summary: "Owner changed Agent Wallet limits",
              data: {
                action_hash: change.actionHash,
                session_binding: change.sessionBinding,
                policy_hash: change.policyHash,
                base_caps: change.baseCaps,
                base_block: change.baseBlock,
                proposed: change.proposed,
                deployment: change.deployment,
                expires_at: new Date(change.expiresAt).toISOString(),
              },
            });
          } catch {
            return error("chain_unavailable", 503);
          }
          change.auditHash = audit.record_hash;
          change.status = "applying";
          policyKeys.set(keyId, { bodyHash, changeId: change.changeId });
          persist();
        } else if (!oldKey) return error("action_changed", 409);
        try {
          await finishPolicyChange(change);
        } catch {
          return error("reconciliation_required", 503);
        }
        const policy = policies.get(userId);
        const capReader = deps.policyCaps;
        if (!policy || !capReader) return error("reconciliation_required", 503);
        let caps: PolicyCapsSnapshot;
        try {
          caps = await capReader.read();
        } catch {
          return error("chain_unavailable", 503);
        }
        return {
          statusCode: 200,
          body: {
            policy,
            policy_hash: policyHash(policy),
            contract: capsPublic(caps),
            sync_status: "consistent",
          },
        };
      }),
    );
  });

  app.get("/v1/app/approvals", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    await expireDueApprovals();
    const status = (request.query as { status?: unknown }).status;
    if (
      status !== undefined &&
      status !== "pending" &&
      status !== "approved" &&
      status !== "rejected" &&
      status !== "expired"
    )
      return send(reply, error("policy_denied", 400));
    const items = [...approvals.values()]
      .filter((entry) => entry.userId === userId)
      .map((entry) => {
        const payment = entry.paymentId
          ? payments.get(entry.paymentId)
          : undefined;
        const mandate = entry.mandateId
          ? mandates.get(entry.mandateId)
          : payment
            ? mandates.get(payment.mandateId)
            : undefined;
        const agent = mandate ? agents.get(mandate.agent_id) : undefined;
        return agent
          ? {
              ...entry.card,
              trust_light: agent.licence.level,
              trust_reason: agent.licence.reason,
            }
          : entry.card;
      })
      .filter((card) => status === undefined || card.status === status);
    return reply.send({ items, next_cursor: null });
  });

  app.get<{ Params: { id: string } }>(
    "/v1/app/approvals/:id/review",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      const entry = approvals.get(request.params.id);
      if (!entry || entry.userId !== userId || !entry.paymentId)
        return send(reply, error("not_found", 404));
      const payment = payments.get(entry.paymentId);
      if (entry.card.review_schema !== "payment_review.v1" || !payment?.review)
        return send(reply, error("not_found", 404));
      if (
        entry.card.status !== "pending" ||
        payment.status !== "awaiting_user" ||
        Date.parse(entry.card.expires_at) <= now().getTime()
      )
        return send(reply, error("action_changed", 409));
      const review = PaymentReviewSchema.parse(payment.review);
      const mandate = mandates.get(payment.mandateId);
      if (!mandate || !compositeReviewStillMatches(entry, payment, mandate))
        return send(reply, error("action_changed", 409));
      return reply.send(review);
    },
  );

  app.get("/v1/app/events", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    await expireDueApprovals();
    const afterValue = (request.query as { after?: unknown }).after;
    const after = afterValue === undefined ? 0 : Number(afterValue);
    if (!Number.isSafeInteger(after) || after < 0)
      return send(reply, error("policy_denied", 400));
    const all = eventsByUser.get(userId) ?? [];
    return reply.send({
      events: all.filter((event) => event.id > after),
      next_cursor: String(all.length),
      version: all.length,
      changed_at: all.at(-1)?.created_at ?? null,
    });
  });

  app.get("/v1/app/agents", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    const items = [...agents.values()]
      .filter((agent) => agent.user_id === userId && !agent.deleted_at)
      .map(agentWithIdleState);
    return reply.send({ items, next_cursor: null });
  });

  app.get<{ Params: { id: string } }>(
    "/v1/app/agents/:id/trust-events",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      const agent = agents.get(request.params.id);
      if (!agent || agent.user_id !== userId)
        return send(reply, error("not_found", 404));
      const items = trustEvents.filter(
        (item) => item.agent_id === agent.agent_id,
      );
      const legacyEvidence = agent.legacy_red_evidence
        ? [agent.legacy_red_evidence]
        : [];
      return reply.send({
        items,
        legacy_evidence: legacyEvidence,
        next_cursor: null,
      });
    },
  );

  app.get("/v1/app/demo/drills", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    if (!deps.demoTrustControlsEnabled)
      return send(reply, error("not_found", 404));
    return reply.send({
      active: activeDrill !== null,
      drill_id: activeDrill?.drillId ?? null,
    });
  });

  for (const action of ["start", "stop"] as const) {
    app.post(`/v1/app/demo/drills/${action}`, async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      if (!deps.demoTrustControlsEnabled || !deps.setDrillVisibility)
        return send(reply, error("not_found", 404));
      const synchronizeVisibility = deps.setDrillVisibility;
      return send(
        reply,
        await idem(userId, request, () =>
          serializePaymentSubmission(userId, async () => {
            if (action === "start" && activeDrill)
              return {
                statusCode: 200,
                body: { active: true, drill_id: activeDrill.drillId },
              };
            if (action === "stop" && !activeDrill)
              return {
                statusCode: 200,
                body: { active: false, drill_id: null },
              };
            const next =
              action === "start"
                ? { drillId: id("drill"), startedAt: now().toISOString() }
                : null;
            const drillSubjectId = next?.drillId ?? activeDrill?.drillId;
            if (!drillSubjectId) return error("action_changed", 409);
            try {
              await synchronizeVisibility(next !== null);
            } catch {
              return error("service_unavailable", 503);
            }
            try {
              await writeAudit({
                kind: "drill",
                actor: userId,
                subjectId: drillSubjectId,
                summary: `Owner ${action === "start" ? "started" : "stopped"} local demo fire drill`,
                data: { action, prior: activeDrill, next },
              });
              const prior = activeDrill;
              activeDrill = next;
              try {
                persist();
              } catch (failure) {
                activeDrill = prior;
                throw failure;
              }
            } catch {
              try {
                await synchronizeVisibility(activeDrill !== null);
              } catch {
                /* startup reconciliation restores bank state */
              }
              return error("service_unavailable", 503);
            }
            return {
              statusCode: 200,
              body: {
                active: activeDrill !== null,
                drill_id: activeDrill?.drillId ?? null,
              },
            };
          }),
        ),
      );
    });
  }

  app.get("/v1/app/home", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    const rail = deps.walletFunding;
    if (!rail) return send(reply, error("chain_unavailable", 503));
    try {
      const snapshot = await rail.snapshot();
      const reserved = reservedWalletFunds(userId);
      return reply.send({
        schema: "home.v1",
        simulated: true,
        main_account: { balance: walletMoney(safeFen(snapshot.mainBalance)) },
        agent_wallet: {
          balance: walletMoney(safeFen(snapshot.walletBalance)),
          reserved: walletMoney(reserved),
          available: walletMoney(
            Math.max(0, safeFen(snapshot.walletBalance) - reserved),
          ),
          address: rail.deployment.wallet,
          frozen: snapshot.walletFrozen,
        },
        block_number: Number(snapshot.blockNumber),
        observed_at: snapshot.observedAt,
        alerts: [],
      });
    } catch {
      return send(reply, error("chain_unavailable", 503));
    }
  });

  async function reconcileHumanPayment(
    item: HumanPaymentRecord,
  ): Promise<void> {
    const rail = deps.walletFunding;
    if (!rail || !item.txHash || item.deployment !== walletDeployment) return;
    try {
      const evidence = await rail.mainPaymentEvidence(
        item.txHash,
        item.payout,
        BigInt(item.amount),
      );
      item.blockNumber = evidence.blockNumber.toString();
      if (!item.shopNotified && deps.notifyMerchantPayment) {
        await deps.notifyMerchantPayment({
          orderId: item.orderId,
          paymentTx: item.txHash,
        });
        item.shopNotified = true;
      }
      item.status = "completed";
      item.completedAt = now().toISOString();
      persist();
    } catch {
      item.status = "reconciliation_required";
      persist();
    }
  }

  app.post("/v1/app/scan/decode", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    const qrPayload = (request.body as { qr_payload?: unknown } | null)
      ?.qr_payload;
    if (typeof qrPayload !== "string" || qrPayload.length > 16_384)
      return send(reply, error("scan_invalid", 400));
    const verificationBase = new URL(
      deps.verificationUriBase ?? "http://127.0.0.1:3002/v1/app/pairing",
    );
    try {
      const codeUrl = new URL(qrPayload);
      const prefix = `${verificationBase.pathname.replace(/\/$/, "")}/`;
      if (
        codeUrl.origin === verificationBase.origin &&
        codeUrl.pathname.startsWith(prefix) &&
        !codeUrl.search &&
        !codeUrl.hash &&
        !codeUrl.username &&
        !codeUrl.password
      ) {
        const userCode = codeUrl.pathname.slice(prefix.length);
        const pairing = pairingByUserCode.get(userCode);
        if (pairing && pairingStatus(pairing) === "pending")
          return reply.send({ kind: "pairing", user_code: userCode });
      }
    } catch {
      // Payment QR payloads use a custom URI scheme, so URL parsing is optional.
    }
    let paymentRequest: PaymentRequest;
    try {
      paymentRequest = decodePaymentRequestUri(qrPayload);
    } catch {
      return send(reply, error("scan_invalid", 400));
    }
    let merchant: Merchant | null;
    try {
      merchant = await deps.lookupMerchant(paymentRequest.merchant_id);
    } catch {
      return send(reply, error("service_unavailable", 503));
    }
    const rail = deps.walletFunding;
    const lineTotal = paymentRequest.line_items.reduce(
      (sum, item) => sum + item.qty * item.unit_price.amount,
      0,
    );
    if (
      !merchant ||
      merchant.honeypot ||
      !merchant.payout ||
      !/^0x[0-9a-fA-F]{40}$/.test(merchant.payout) ||
      merchant.payout.toLowerCase() === rail?.deployment.main.toLowerCase() ||
      merchant.payout.toLowerCase() === rail?.deployment.wallet.toLowerCase() ||
      !verifyMerchantSignature(paymentRequest, merchant.public_key) ||
      Date.parse(paymentRequest.expires_at) <= now().getTime() ||
      paymentRequest.amount.currency !== "CNY" ||
      !Number.isSafeInteger(lineTotal) ||
      lineTotal !== paymentRequest.amount.amount ||
      orderCommitted(paymentRequest.merchant_id, paymentRequest.order_id) ||
      usedMerchantNonces.has(
        `${paymentRequest.merchant_id}:${paymentRequest.nonce}`,
      )
    )
      return send(reply, error("scan_invalid", 400));
    if (!rail || !walletDeployment)
      return send(reply, error("chain_unavailable", 503));
    return send(
      reply,
      await serializePaymentSubmission(userId, async () => {
        if (orderCommitted(paymentRequest.merchant_id, paymentRequest.order_id))
          return error("scan_invalid", 400);
        const confirmationId = id("hpm");
        const challengeId = id("hpc");
        const expiresAt = Math.min(
          now().getTime() + 60_000,
          Date.parse(paymentRequest.expires_at),
        );
        const paymentRequestHash = sha256(qrPayload);
        const sessionBinding = appSessionBinding(request);
        const actionHash = sha256({
          schema: "human_payment_action.v1",
          user_id: userId,
          session: sessionBinding,
          confirmation_id: confirmationId,
          challenge_id: challengeId,
          payment_request_hash: paymentRequestHash,
          merchant_id: merchant.merchant_id,
          merchant_legal_name: merchant.legal_name,
          merchant_uscc: merchant.uscc,
          order_id: paymentRequest.order_id,
          amount: paymentRequest.amount,
          source_account: "main",
          deployment: walletDeployment,
          expires_at: new Date(expiresAt).toISOString(),
        });
        const record: HumanPaymentRecord = {
          confirmationId,
          challengeId,
          userId,
          sessionBinding,
          merchantId: merchant.merchant_id,
          merchantLegalName: merchant.legal_name,
          merchantUscc: merchant.uscc,
          merchantPublicKey: merchant.public_key,
          payout: merchant.payout as `0x${string}`,
          orderId: paymentRequest.order_id,
          nonceKey: `${paymentRequest.merchant_id}:${paymentRequest.nonce}`,
          paymentRequestHash,
          paymentRequestExpiresAt: Date.parse(paymentRequest.expires_at),
          amount: paymentRequest.amount.amount,
          actionHash,
          expiresAt,
          consumed: false,
          status: "prepared",
          deployment: walletDeployment,
          startingBlock: "0",
          createdAt: now().toISOString(),
        };
        humanPaymentRecords.set(confirmationId, record);
        persist();
        return {
          statusCode: 200,
          body: {
            kind: "payment",
            confirmation_id: confirmationId,
            challenge_id: challengeId,
            action_hash: actionHash,
            merchant_id: merchant.merchant_id,
            merchant_legal_name: merchant.legal_name,
            merchant_uscc: merchant.uscc,
            order_id: paymentRequest.order_id,
            amount: paymentRequest.amount,
            source_account: "main",
            expires_at: new Date(expiresAt).toISOString(),
            simulated: true,
          },
        };
      }),
    );
  });

  app.get<{ Params: { confirmationId: string } }>(
    "/v1/app/scan/payments/:confirmationId",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      const record = humanPaymentRecords.get(request.params.confirmationId);
      if (!record || record.userId !== userId)
        return send(reply, error("not_found", 404));
      if (record.status === "reconciliation_required")
        await reconcileHumanPayment(record);
      return reply.send(humanPaymentPublic(record));
    },
  );

  app.post<{ Params: { confirmationId: string } }>(
    "/v1/app/scan/payments/:confirmationId/confirm",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || key.length < 1 || key.length > 255)
        return send(reply, error("idempotency_conflict", 409));
      const body = request.body as {
        challenge_id?: unknown;
        verification?: { action_hash?: unknown; device_signature?: unknown };
      } | null;
      if (
        typeof body?.challenge_id !== "string" ||
        typeof body.verification?.action_hash !== "string" ||
        typeof body.verification?.device_signature !== "string"
      )
        return send(reply, error("invalid_request", 400));
      const verification = body.verification;
      if (!verification) return send(reply, error("invalid_request", 400));
      const keyId = `${userId}:human:${key}`;
      const bodyHash = sha256(body);
      return send(
        reply,
        await serializePaymentSubmission(userId, async () => {
          const existing = humanPaymentKeys.get(keyId);
          if (existing) {
            if (existing.bodyHash !== bodyHash)
              return error("idempotency_conflict", 409);
            const record = humanPaymentRecords.get(existing.confirmationId);
            if (!record || record.userId !== userId)
              return error("reconciliation_required", 503);
            if (record.status === "reconciliation_required")
              await reconcileHumanPayment(record);
            return record.status === "completed"
              ? { statusCode: 200, body: humanPaymentPublic(record) }
              : error("reconciliation_required", 503);
          }
          const record = humanPaymentRecords.get(request.params.confirmationId);
          if (
            !record ||
            record.userId !== userId ||
            record.challengeId !== body.challenge_id ||
            record.actionHash !== verification.action_hash ||
            record.sessionBinding !== appSessionBinding(request) ||
            record.deployment !== walletDeployment ||
            record.expiresAt <= now().getTime() ||
            record.paymentRequestExpiresAt <= now().getTime() ||
            record.consumed ||
            record.status !== "prepared"
          )
            return error("action_changed", 409);
          if (!deps.verifyHumanPaymentProof)
            return error("service_unavailable", 503);
          if (
            !(await deps.verifyHumanPaymentProof(
              record.actionHash,
              verification,
              userId,
            ))
          )
            return error("bad_signature", 401);
          const rail = deps.walletFunding;
          if (!rail || !walletDeployment)
            return error("chain_unavailable", 503);
          let currentMerchant: Merchant | null;
          try {
            currentMerchant = await deps.lookupMerchant(record.merchantId);
          } catch {
            return error("service_unavailable", 503);
          }
          if (
            !currentMerchant ||
            currentMerchant.honeypot ||
            currentMerchant.public_key !== record.merchantPublicKey ||
            currentMerchant.legal_name !== record.merchantLegalName ||
            currentMerchant.uscc !== record.merchantUscc ||
            currentMerchant.payout?.toLowerCase() !==
              record.payout.toLowerCase()
          )
            return error("action_changed", 409);
          if (
            balanceChangePending(userId) ||
            orderCommitted(record.merchantId, record.orderId) ||
            usedMerchantNonces.has(record.nonceKey)
          )
            return error("action_changed", 409);
          let snapshot: WalletSnapshot;
          try {
            snapshot = await rail.snapshot();
          } catch {
            return error("chain_unavailable", 503);
          }
          if (snapshot.mainBalance < BigInt(record.amount))
            return agentDenied("insufficient_main_funds");
          record.consumed = true;
          record.status = "settling";
          record.startingBlock = snapshot.blockNumber.toString();
          usedMerchantNonces.add(record.nonceKey);
          humanPaymentKeys.set(keyId, {
            bodyHash,
            confirmationId: record.confirmationId,
          });
          persist();
          try {
            const tx = await rail.payFromMain(
              record.confirmationId,
              BigInt(record.amount),
            );
            record.txHash = tx;
            persist();
            await reconcileHumanPayment(record);
            const settled = humanPaymentRecords.get(record.confirmationId);
            if (settled?.status === "completed")
              return { statusCode: 200, body: humanPaymentPublic(settled) };
          } catch {
            record.status = "reconciliation_required";
            persist();
          }
          return {
            statusCode: 503,
            body: {
              error: {
                code: "reconciliation_required",
                confirmation_id: record.confirmationId,
                ...(record.txHash ? { payment_tx: record.txHash } : {}),
              },
            },
          };
        }),
      );
    },
  );

  app.post("/v1/app/agent-wallet/funding/prepare", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    const rail = deps.walletFunding;
    if (!rail || !walletDeployment)
      return send(reply, error("chain_unavailable", 503));
    const amount = PositiveMoneySchema.safeParse(
      (request.body as { amount?: unknown } | null)?.amount,
    );
    if (!amount.success || amount.data.currency !== "CNY")
      return send(reply, error("invalid_request", 400));
    return send(
      reply,
      await serializePaymentSubmission(userId, async () => {
        if (balanceChangePending(userId))
          return error("reconciliation_required", 503);
        let snapshot: WalletSnapshot;
        try {
          snapshot = await rail.snapshot();
        } catch {
          return error("chain_unavailable", 503);
        }
        if (BigInt(amount.data.amount) > snapshot.mainBalance)
          return agentDenied("insufficient_main_funds");
        const fundingId = id("fnd");
        const challengeId = id("fch");
        const expiresAt = now().getTime() + 60_000;
        const actionHash = sha256({
          schema: "funding_action.v1",
          user_id: userId,
          session: appSessionBinding(request),
          funding_id: fundingId,
          challenge_id: challengeId,
          amount: amount.data,
          source: rail.deployment.main,
          destination: rail.deployment.wallet,
          deployment: walletDeployment,
          expires_at: new Date(expiresAt).toISOString(),
        });
        fundingRecords.set(fundingId, {
          fundingId,
          userId,
          amount: amount.data.amount,
          status: "prepared",
          deployment: walletDeployment,
          startingBlock: snapshot.blockNumber.toString(),
          createdAt: now().toISOString(),
        });
        fundingChallenges.set(challengeId, {
          challengeId,
          fundingId,
          userId,
          sessionBinding: appSessionBinding(request),
          amount: amount.data.amount,
          actionHash,
          expiresAt,
          consumed: false,
        });
        return {
          statusCode: 200,
          body: {
            funding_id: fundingId,
            challenge_id: challengeId,
            action_hash: actionHash,
            expires_at: new Date(expiresAt).toISOString(),
            source_balance: walletMoney(safeFen(snapshot.mainBalance)),
            destination_balance: walletMoney(safeFen(snapshot.walletBalance)),
            destination_address: rail.deployment.wallet,
            simulated: true,
          },
        };
      }),
    );
  });

  app.post("/v1/app/agent-wallet/funding", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    const rail = deps.walletFunding;
    if (!rail || !walletDeployment)
      return send(reply, error("chain_unavailable", 503));
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 1 || key.length > 255)
      return send(reply, error("idempotency_conflict", 409));
    const body = request.body as {
      funding_id?: unknown;
      challenge_id?: unknown;
      amount?: unknown;
      verification?: { action_hash?: unknown; device_signature?: unknown };
    } | null;
    const amount = PositiveMoneySchema.safeParse(body?.amount);
    if (
      !amount.success ||
      amount.data.currency !== "CNY" ||
      typeof body?.funding_id !== "string" ||
      typeof body.challenge_id !== "string" ||
      typeof body.verification?.action_hash !== "string"
    )
      return send(reply, error("invalid_request", 400));
    const fundingId = body.funding_id;
    const challengeId = body.challenge_id;
    const verification = body.verification;
    const keyId = `${userId}:${key}`;
    const bodyHash = sha256(body);
    return send(
      reply,
      await serializePaymentSubmission(userId, async () => {
        const existing = fundingKeys.get(keyId);
        if (existing) {
          if (existing.bodyHash !== bodyHash)
            return error("idempotency_conflict", 409);
          const record = fundingRecords.get(existing.fundingId);
          if (!record) return error("reconciliation_required", 503);
          if (record.status === "completed")
            return { statusCode: 200, body: fundingPublic(record) };
          if (record.status === "failed")
            return agentDenied("insufficient_main_funds");
          return {
            statusCode: 503,
            body: {
              error: {
                code: "reconciliation_required",
                funding_id: record.fundingId,
                ...(record.txHash ? { funding_tx: record.txHash } : {}),
              },
            },
          };
        }
        const challenge = fundingChallenges.get(challengeId);
        const record = fundingRecords.get(fundingId);
        if (
          !challenge ||
          !record ||
          challenge.fundingId !== record.fundingId ||
          challenge.userId !== userId ||
          record.userId !== userId ||
          challenge.consumed ||
          challenge.expiresAt <= now().getTime() ||
          challenge.sessionBinding !== appSessionBinding(request) ||
          challenge.amount !== amount.data.amount ||
          record.amount !== amount.data.amount ||
          challenge.actionHash !== verification.action_hash ||
          record.deployment !== walletDeployment
        )
          return error("action_changed", 409);
        if (!deps.verifyFundingProof) return error("policy_denied", 503);
        const verified = await deps.verifyFundingProof(
          challenge.actionHash,
          verification,
          userId,
        );
        if (!verified) return error("bad_signature", 401);
        if (balanceChangePending(userId))
          return error("reconciliation_required", 503);
        let snapshot: WalletSnapshot;
        try {
          snapshot = await rail.snapshot();
        } catch {
          return error("chain_unavailable", 503);
        }
        fundingKeys.set(keyId, { bodyHash, fundingId: record.fundingId });
        challenge.consumed = true;
        if (BigInt(record.amount) > snapshot.mainBalance) {
          record.status = "failed";
          persist();
          return agentDenied("insufficient_main_funds");
        }
        record.status = "settling";
        record.startingBlock = snapshot.blockNumber.toString();
        persist();
        try {
          const tx = await rail.fund(record.fundingId, BigInt(record.amount));
          record.txHash = tx;
          persist();
          const evidence = await rail.fundingEvidence(tx, record.fundingId);
          if (!transferMatches(evidence, record.amount))
            throw new Error("Funding evidence mismatch");
          record.blockNumber = evidence.blockNumber.toString();
          record.completedAt = now().toISOString();
          record.status = "completed";
          emitEvent(userId, "wallet.funded", {
            funding_id: record.fundingId,
            amount: walletMoney(record.amount),
            chain_tx: tx,
          });
          persist();
          return { statusCode: 200, body: fundingPublic(record) };
        } catch {
          record.status = "reconciliation_required";
          persist();
          return {
            statusCode: 503,
            body: {
              error: {
                code: "reconciliation_required",
                funding_id: record.fundingId,
                ...(record.txHash ? { funding_tx: record.txHash } : {}),
              },
            },
          };
        }
      }),
    );
  });

  app.get<{ Params: { fundingId: string } }>(
    "/v1/app/agent-wallet/funding/:fundingId",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      const record = fundingRecords.get(request.params.fundingId);
      if (!record || record.userId !== userId)
        return send(reply, error("not_found", 404));
      try {
        await reconcileFunding(record);
      } catch {
        /* Keep uncertain intent blocked. */
      }
      return reply.send(fundingPublic(record));
    },
  );

  app.get("/v1/app/agent-wallet/funding", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    return reply.send({
      items: [...fundingRecords.values()]
        .filter((item) => item.userId === userId)
        .map(fundingPublic),
      next_cursor: null,
    });
  });

  app.post("/v1/app/agent-wallet/sweep", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    const rail = deps.walletFunding;
    if (!rail || !walletDeployment)
      return send(reply, error("chain_unavailable", 503));
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 1 || key.length > 255)
      return send(reply, error("idempotency_conflict", 409));
    const amount = PositiveMoneySchema.safeParse(
      (request.body as { amount?: unknown } | null)?.amount,
    );
    if (!amount.success || amount.data.currency !== "CNY")
      return send(reply, error("invalid_request", 400));
    const keyId = `${userId}:${key}`;
    const bodyHash = sha256(request.body);
    return send(
      reply,
      await serializePaymentSubmission(userId, async () => {
        const existing = sweepKeys.get(keyId);
        if (existing) {
          if (existing.bodyHash !== bodyHash)
            return error("idempotency_conflict", 409);
          const record = sweepRecords.get(existing.sweepId);
          if (!record) return error("reconciliation_required", 503);
          try {
            await reconcileSweep(record);
          } catch {
            /* Keep uncertain intent blocked. */
          }
          return record.status === "completed"
            ? { statusCode: 200, body: sweepPublic(record) }
            : {
                statusCode: 503,
                body: {
                  error: {
                    code: "reconciliation_required",
                    sweep_id: record.sweepId,
                  },
                },
              };
        }
        if (
          balanceChangePending(userId) ||
          [...mandates.values()].some(
            (mandate) =>
              agents.get(mandate.agent_id)?.user_id === userId &&
              mandate.in_flight_payment_id,
          )
        )
          return error("reconciliation_required", 503);
        let snapshot: WalletSnapshot;
        try {
          snapshot = await rail.snapshot();
        } catch {
          return error("chain_unavailable", 503);
        }
        if (
          BigInt(amount.data.amount + reservedWalletFunds(userId)) >
          snapshot.walletBalance
        )
          return agentDenied("insufficient_wallet_funds");
        const record: SweepRecord = {
          sweepId: id("swp"),
          userId,
          amount: amount.data.amount,
          status: "settling",
          deployment: walletDeployment,
          startingBlock: snapshot.blockNumber.toString(),
          createdAt: now().toISOString(),
        };
        sweepRecords.set(record.sweepId, record);
        sweepKeys.set(keyId, { bodyHash, sweepId: record.sweepId });
        persist();
        try {
          const tx = await rail.sweep(record.sweepId, BigInt(record.amount));
          record.txHash = tx;
          persist();
          const evidence = await rail.sweepEvidence(tx, record.sweepId);
          if (!transferMatches(evidence, record.amount))
            throw new Error("Sweep evidence mismatch");
          record.blockNumber = evidence.blockNumber.toString();
          record.completedAt = now().toISOString();
          record.status = "completed";
          emitEvent(userId, "wallet.swept", {
            sweep_id: record.sweepId,
            amount: walletMoney(record.amount),
            chain_tx: tx,
          });
          persist();
          return { statusCode: 200, body: sweepPublic(record) };
        } catch {
          record.status = "reconciliation_required";
          persist();
          return {
            statusCode: 503,
            body: {
              error: {
                code: "reconciliation_required",
                sweep_id: record.sweepId,
                ...(record.txHash ? { sweep_tx: record.txHash } : {}),
              },
            },
          };
        }
      }),
    );
  });

  app.get<{ Params: { sweepId: string } }>(
    "/v1/app/agent-wallet/sweep/:sweepId",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      const record = sweepRecords.get(request.params.sweepId);
      if (!record || record.userId !== userId)
        return send(reply, error("not_found", 404));
      try {
        await reconcileSweep(record);
      } catch {
        /* Keep uncertain intent blocked. */
      }
      return reply.send(sweepPublic(record));
    },
  );

  app.get("/v1/app/agent-wallet/sweep", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    return reply.send({
      items: [...sweepRecords.values()]
        .filter((item) => item.userId === userId)
        .map(sweepPublic),
      next_cursor: null,
    });
  });

  app.get("/v1/app/mandates", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    await expireDueApprovals();
    const items = [...mandates.values()]
      .filter((mandate) => agents.get(mandate.agent_id)?.user_id === userId)
      .map((mandate) => {
        const window = mandate.constraints.find(
          (constraint) => constraint.type === "execution_window",
        );
        return (mandate.status === "active" ||
          mandate.status === "pending_checkout") &&
          window &&
          Date.parse(window.not_after) <= now().getTime()
          ? { ...mandate, status: "expired" as const }
          : mandate;
      });
    return reply.send({ items, next_cursor: null });
  });

  app.get<{ Params: { id: string } }>(
    "/v1/app/agents/:id/history",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      const agent = agents.get(request.params.id);
      if (!agent || agent.user_id !== userId)
        return send(reply, error("not_found", 404));
      const root = agent.lineage?.root_agent_id ?? agent.agent_id;
      const lineage = new Set(
        [...agents.values()]
          .filter(
            (item) =>
              item.user_id === userId &&
              (item.lineage?.root_agent_id ?? item.agent_id) === root,
          )
          .map((item) => item.agent_id),
      );
      const items = audits
        .filter(
          (item) => lineage.has(item.subject_id) || lineage.has(item.actor),
        )
        .map((item) => ({
          event_id: item.audit_id,
          agent_id: lineage.has(item.subject_id) ? item.subject_id : item.actor,
          kind: item.kind,
          summary: item.summary,
          created_at: item.created_at,
          audit_tx: item.chain_tx,
        }));
      return reply.send({ root_agent_id: root, items, next_cursor: null });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/app/agents/:id/prepare-idle-reauthorization",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      if (typeof request.headers["idempotency-key"] !== "string")
        return send(reply, error("idempotency_conflict", 409));
      const agent = agents.get(request.params.id);
      if (!agent || agent.user_id !== userId)
        return send(reply, error("policy_denied", 403));
      if (
        agent.status !== "active" ||
        agent.deleted_at ||
        agent.licence.level === "RED" ||
        replacingAgents.has(agent.agent_id)
      )
        return send(reply, error("agent_frozen", 401));
      if (
        !idleRequired(agent) ||
        !agent.client_app_id ||
        !agent.client_app_name
      )
        return send(reply, error("action_changed", 409));
      const challengeId = id("chg");
      const challenge = randomBytes(32).toString("base64url");
      const expiresAt = now().getTime() + 60_000;
      const sessionBinding = appSessionBinding(request);
      const actionHash = sha256({
        schema: "idle_reauthorization.v1",
        user_id: userId,
        agent_id: agent.agent_id,
        client_app_id: agent.client_app_id,
        public_key: agent.public_key,
        scopes: agent.scopes,
        last_used_at: agent.last_used_at,
        expected_status: agent.status,
        expected_licence_level: agent.licence.level,
        challenge_id: challengeId,
        expires_at: new Date(expiresAt).toISOString(),
        session_binding: sessionBinding,
      });
      idleChallenges.set(challengeId, {
        challengeId,
        userId,
        agentId: agent.agent_id,
        actionHash,
        sessionBinding,
        challenge,
        expiresAt,
        used: false,
      });
      return reply.send({
        action: "idle_reauthorize",
        agent_id: agent.agent_id,
        action_hash: actionHash,
        challenge_id: challengeId,
        challenge,
        expires_at: new Date(expiresAt).toISOString(),
        agent_summary: {
          agent_id: agent.agent_id,
          display_name: agent.display_name,
          client_app_id: agent.client_app_id,
          client_app_name: agent.client_app_name,
          public_key_preview: `${agent.public_key.slice(0, 24)}...`,
          scopes: agent.scopes,
          last_used_at: agent.last_used_at,
          idle_expires_at: idleExpiresAt(agent),
        },
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/app/agents/:id/idle-reauthorize",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      return send(
        reply,
        await idem(userId, request, () =>
          serializePaymentSubmission(userId, async () => {
            const body = request.body as {
              challenge_id?: string;
              verification?: {
                action_hash?: string;
                device_signature?: string;
              };
            } | null;
            const challenge = body?.challenge_id
              ? idleChallenges.get(body.challenge_id)
              : null;
            const agent = agents.get(request.params.id);
            if (!agent || agent.user_id !== userId)
              return error("policy_denied", 403);
            if (
              agent.status !== "active" ||
              agent.deleted_at ||
              agent.licence.level === "RED" ||
              replacingAgents.has(agent.agent_id)
            )
              return error("agent_frozen", 401);
            if (
              !challenge ||
              challenge.used ||
              challenge.userId !== userId ||
              challenge.agentId !== agent.agent_id ||
              challenge.sessionBinding !== appSessionBinding(request) ||
              challenge.expiresAt <= now().getTime() ||
              !idleRequired(agent) ||
              !agent.client_app_id ||
              !agent.client_app_name
            )
              return error("action_changed", 409);
            const currentHash = sha256({
              schema: "idle_reauthorization.v1",
              user_id: userId,
              agent_id: agent.agent_id,
              client_app_id: agent.client_app_id,
              public_key: agent.public_key,
              scopes: agent.scopes,
              last_used_at: agent.last_used_at,
              expected_status: agent.status,
              expected_licence_level: agent.licence.level,
              challenge_id: challenge.challengeId,
              expires_at: new Date(challenge.expiresAt).toISOString(),
              session_binding: challenge.sessionBinding,
            });
            if (currentHash !== challenge.actionHash)
              return error("action_changed", 409);
            if (body?.verification?.action_hash !== challenge.actionHash)
              return error("bad_signature", 401);
            if (!demoProofAvailable) return error("policy_denied", 503);
            const card = approvalCard(
              "pairing",
              "zero_trust",
              agent.agent_id,
              `Re-approve ${agent.client_app_name}`,
              [challenge.challenge],
              { actionHash: challenge.actionHash },
            );
            card.payload_hash = challenge.actionHash;
            if (!(await verifyDemoProof(card, body.verification, userId)))
              return error("bad_signature", 401);
            try {
              await writeAudit({
                kind: "pairing",
                actor: userId,
                subjectId: agent.agent_id,
                summary: `Local demo simulated idle re-approval for ${agent.client_app_name}`,
                data: {
                  action: "idle_reauthorize",
                  agent_id: agent.agent_id,
                  client_app_id: agent.client_app_id,
                  client_app_name: agent.client_app_name,
                  public_key: agent.public_key,
                  scopes: agent.scopes,
                  last_used_at: agent.last_used_at,
                  action_hash: challenge.actionHash,
                  challenge_id: challenge.challengeId,
                  challenge_expires_at: new Date(
                    challenge.expiresAt,
                  ).toISOString(),
                  session_binding: challenge.sessionBinding,
                },
              });
            } catch (failure) {
              app.log.error(
                { err: failure, agentId: agent.agent_id },
                "Idle re-approval audit failed",
              );
              return error("service_unavailable", 503);
            }
            const renewalExpiresAt = now().getTime() + IDLE_RENEWAL_MS;
            const previous = idleRenewals.get(agent.agent_id);
            idleRenewals.set(agent.agent_id, {
              agentId: agent.agent_id,
              publicKey: agent.public_key,
              expiresAt: renewalExpiresAt,
              consumed: false,
            });
            challenge.used = true;
            try {
              persist();
            } catch (failure) {
              if (previous) idleRenewals.set(agent.agent_id, previous);
              else idleRenewals.delete(agent.agent_id);
              challenge.used = false;
              app.log.error(
                { err: failure, agentId: agent.agent_id },
                "Idle re-approval persistence failed",
              );
              return error("service_unavailable", 503);
            }
            emitEvent(userId, "agent.idle_reapproval_prepared", {
              agent_id: agent.agent_id,
            });
            return {
              statusCode: 200,
              body: {
                agent: agentWithIdleState(agent),
                renewal_expires_at: new Date(renewalExpiresAt).toISOString(),
              },
            };
          }),
        ),
      );
    },
  );

  for (const trustAction of [
    "return_to_amber",
    "demo_fast_forward_green",
  ] as const) {
    const base =
      trustAction === "return_to_amber"
        ? "/v1/app/agents/:id"
        : "/v1/app/demo/agents/:id";
    const suffix =
      trustAction === "return_to_amber"
        ? "return-to-amber"
        : "fast-forward-green";
    app.post<{ Params: { id: string } }>(
      `${base}/prepare-${suffix}`,
      async (request, reply) => {
        const userId = await appUser(request);
        if (!userId) return send(reply, error("bad_signature", 401));
        if (
          trustAction === "demo_fast_forward_green" &&
          !deps.demoTrustControlsEnabled
        )
          return send(reply, error("not_found", 404));
        const agent = agents.get(request.params.id);
        if (!agent || agent.user_id !== userId || agent.deleted_at)
          return send(reply, error("not_found", 404));
        if (trustPending.has(agent.agent_id))
          return send(reply, error("reconciliation_required", 503));
        if (
          trustAction === "return_to_amber"
            ? agent.licence.level !== "RED"
            : agent.licence.level !== "AMBER"
        )
          return send(reply, error("action_changed", 409));
        const challengeId = id("chg");
        const challenge = randomBytes(32).toString("base64url");
        const expiresAt = now().getTime() + 60_000;
        const sessionBinding = appSessionBinding(request);
        const actionHash =
          trustAction === "return_to_amber"
            ? trustResetActionHash(
                agent,
                userId,
                sessionBinding,
                challengeId,
                expiresAt,
              )
            : sha256({
                schema: "trust_action.v1",
                action: trustAction,
                user_id: userId,
                session_binding: sessionBinding,
                challenge_id: challengeId,
                expires_at: new Date(expiresAt).toISOString(),
                agent: trustActionSummary(agent),
                public_key: agent.public_key,
              });
        actionChallenges.set(challengeId, {
          userId,
          agentId: agent.agent_id,
          action: trustAction,
          actionHash,
          sessionBinding,
          challenge,
          expiresAt,
          used: false,
        });
        persist();
        return reply.send({
          action: trustAction,
          agent_id: agent.agent_id,
          action_hash: actionHash,
          challenge_id: challengeId,
          challenge,
          expires_at: new Date(expiresAt).toISOString(),
          agent_summary: trustActionSummary(agent),
        });
      },
    );
    app.post<{ Params: { id: string } }>(
      `${base}/${suffix}`,
      async (request, reply) => {
        const userId = await appUser(request);
        if (!userId) return send(reply, error("bad_signature", 401));
        if (
          trustAction === "demo_fast_forward_green" &&
          !deps.demoTrustControlsEnabled
        )
          return send(reply, error("not_found", 404));
        return send(
          reply,
          await idem(userId, request, () =>
            serializePaymentSubmission(userId, async () => {
              const body = request.body as {
                simulated?: unknown;
                challenge_id?: unknown;
                verification?: {
                  action_hash?: unknown;
                  device_signature?: unknown;
                };
              } | null;
              const challenge =
                typeof body?.challenge_id === "string"
                  ? actionChallenges.get(body.challenge_id)
                  : undefined;
              const agent = agents.get(request.params.id);
              if (
                !agent ||
                agent.user_id !== userId ||
                !challenge ||
                challenge.userId !== userId ||
                challenge.agentId !== agent.agent_id ||
                challenge.action !== trustAction ||
                challenge.used ||
                challenge.expiresAt <= now().getTime() ||
                challenge.sessionBinding !== appSessionBinding(request)
              )
                return error("action_changed", 409);
              if (
                trustAction === "demo_fast_forward_green" &&
                body?.simulated !== true
              )
                return error("invalid_request", 400);
              if (
                trustAction === "return_to_amber"
                  ? agent.licence.level !== "RED"
                  : agent.licence.level !== "AMBER"
              )
                return error("action_changed", 409);
              const currentHash =
                trustAction === "return_to_amber"
                  ? trustResetActionHash(
                      agent,
                      userId,
                      challenge.sessionBinding,
                      body?.challenge_id as string,
                      challenge.expiresAt,
                    )
                  : sha256({
                      schema: "trust_action.v1",
                      action: trustAction,
                      user_id: userId,
                      session_binding: challenge.sessionBinding,
                      challenge_id: body?.challenge_id,
                      expires_at: new Date(challenge.expiresAt).toISOString(),
                      agent: trustActionSummary(agent),
                      public_key: agent.public_key,
                    });
              if (currentHash !== challenge.actionHash)
                return error("action_changed", 409);
              if (body?.verification?.action_hash !== challenge.actionHash)
                return error("bad_signature", 401);
              const proofCard = approvalCard(
                "pairing",
                "everyday",
                agent.agent_id,
                trustAction,
                [challenge.challenge],
                { actionHash: challenge.actionHash },
              );
              proofCard.payload_hash = challenge.actionHash;
              if (
                !(await verifyDemoProof(proofCard, body.verification, userId))
              )
                return error("bad_signature", 401);
              try {
                await writeAudit({
                  kind: "licence_change",
                  actor: userId,
                  subjectId: agent.agent_id,
                  summary: `Owner ${trustAction} proof`,
                  data: {
                    action: trustAction,
                    action_hash: challenge.actionHash,
                    challenge_id: body?.challenge_id,
                    challenge: challenge.challenge,
                    session_binding: challenge.sessionBinding,
                    expires_at: new Date(challenge.expiresAt).toISOString(),
                    agent: trustActionSummary(agent),
                    public_key: agent.public_key,
                  },
                });
                if (
                  trustAction === "return_to_amber" &&
                  !(await retireRedAgentAuthority(agent))
                )
                  throw new Error("Red authority retirement failed");
                const event = await recordTrustEvent(
                  agent,
                  trustAction === "return_to_amber"
                    ? "transition"
                    : "demo_override",
                  `${trustAction}:${challenge.actionHash}`,
                  trustAction === "return_to_amber"
                    ? "Owner returned Red agent to Amber after history review"
                    : "SIMULATED LOCAL DEMO Green fast-forward by owner",
                  trustAction === "return_to_amber" ? "AMBER" : "GREEN",
                );
                challenge.used = true;
                persist();
                return {
                  statusCode: 200,
                  body: {
                    agent: agentWithIdleState(agent),
                    trust_event: event,
                    simulated: true,
                  },
                };
              } catch {
                return error("reconciliation_required", 503);
              }
            }),
          ),
        );
      },
    );
  }

  app.post<{ Params: { id: string } }>(
    "/v1/app/agents/:id/prepare-action",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      if (typeof request.headers["idempotency-key"] !== "string")
        return send(reply, error("idempotency_conflict", 409));
      const agent = agents.get(request.params.id);
      const action = (request.body as { action?: unknown } | null)?.action;
      if (
        !agent ||
        agent.user_id !== userId ||
        agent.deleted_at ||
        (action !== "unfreeze" && action !== "relicense")
      )
        return send(reply, error("policy_denied", 403));
      if (
        (action === "unfreeze" && agent.status !== "frozen") ||
        action === "relicense"
      )
        return send(reply, error("action_changed", 409));
      const actionHash = sha256({
        schema: "agent_action.v1",
        action,
        user_id: userId,
        agent_id: agent.agent_id,
        expected_status: agent.status,
        expected_licence_level: agent.licence.level,
        root_agent_id: agent.lineage?.root_agent_id ?? agent.agent_id,
        demerit_count: agent.licence.flags_30d,
      });
      const challengeId = id("chg");
      const challenge = randomBytes(32).toString("base64url");
      const expiresAt = now().getTime() + 60_000;
      actionChallenges.set(challengeId, {
        userId,
        agentId: agent.agent_id,
        action,
        actionHash,
        sessionBinding: appSessionBinding(request),
        challenge,
        expiresAt,
        used: false,
      });
      return reply.send({
        action,
        agent_id: agent.agent_id,
        action_hash: actionHash,
        challenge_id: challengeId,
        challenge,
        expires_at: new Date(expiresAt).toISOString(),
        agent_summary: replacementSummary(agent),
      });
    },
  );

  for (const action of ["unfreeze"] as const) {
    app.post<{ Params: { id: string } }>(
      `/v1/app/agents/:id/${action}`,
      async (request, reply) => {
        const userId = await appUser(request);
        if (!userId) return send(reply, error("bad_signature", 401));
        return send(
          reply,
          await idem(userId, request, async () => {
            const body = request.body as {
              challenge_id?: string;
              verification?: {
                action_hash?: string;
                device_signature?: string;
              };
            } | null;
            const challenge = body?.challenge_id
              ? actionChallenges.get(body.challenge_id)
              : null;
            const agent = agents.get(request.params.id);
            if (
              !agent ||
              agent.user_id !== userId ||
              !challenge ||
              challenge.userId !== userId ||
              challenge.sessionBinding !== appSessionBinding(request) ||
              challenge.agentId !== agent.agent_id ||
              challenge.action !== action ||
              challenge.used ||
              challenge.expiresAt <= now().getTime()
            )
              return error("action_changed", 409);
            const currentHash = sha256({
              schema: "agent_action.v1",
              action,
              user_id: userId,
              agent_id: agent.agent_id,
              expected_status: agent.status,
              expected_licence_level: agent.licence.level,
              root_agent_id: agent.lineage?.root_agent_id ?? agent.agent_id,
              demerit_count: agent.licence.flags_30d,
            });
            if (currentHash !== challenge.actionHash)
              return error("action_changed", 409);
            if (body?.verification?.action_hash !== challenge.actionHash)
              return error("bad_signature", 401);
            if (!demoProofAvailable) return error("policy_denied", 503);
            const card = approvalCard(
              "pairing",
              "everyday",
              agent.agent_id,
              `${action} ${agent.display_name}`,
              [challenge.challenge],
              { actionHash: challenge.actionHash },
            );
            card.payload_hash = challenge.actionHash;
            if (!(await verifyDemoProof(card, body.verification, userId)))
              return error("bad_signature", 401);
            await writeAudit({
              kind: action === "unfreeze" ? "freeze" : "licence_change",
              actor: userId,
              subjectId: agent.agent_id,
              summary: `Local demo simulated ${action} approved by user`,
              data: {
                action,
                agent_id: agent.agent_id,
                action_hash: challenge.actionHash,
                challenge_id: body?.challenge_id,
                challenge_expires_at: new Date(
                  challenge.expiresAt,
                ).toISOString(),
                session_binding: challenge.sessionBinding,
                public_key: agent.public_key,
                scopes: agent.scopes,
                prior_status: agent.status,
                prior_licence_level: agent.licence.level,
                root_agent_id: agent.lineage?.root_agent_id ?? agent.agent_id,
                demerit_count: agent.licence.flags_30d,
              },
            });
            challenge.used = true;
            invalidateIdleRecovery(agent.agent_id);
            agent.status = "active";
            emitEvent(userId, `agent.${action}`, { agent_id: agent.agent_id });
            return { statusCode: 200, body: { agent, simulated: true } };
          }),
        );
      },
    );
  }

  app.post<{ Params: { id: string } }>(
    "/v1/app/agents/:id/relicense",
    async (_request, reply) => send(reply, error("invalid_request", 410)),
  );

  app.post<{ Params: { id: string } }>(
    "/v1/app/agents/:id/revoke",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      return send(
        reply,
        await idem(userId, request, () =>
          serializePaymentSubmission(userId, async () => {
            const agent = agents.get(request.params.id);
            if (!agent || agent.user_id !== userId || agent.deleted_at)
              return error("not_found", 404);
            if (
              (request.body as { confirmation_agent_id?: unknown } | null)
                ?.confirmation_agent_id !== agent.agent_id
            )
              return error("invalid_request", 400);
            agent.status = "revoked";
            invalidateIdleRecovery(agent.agent_id);
            agentAuth.revokeAgent(agent.agent_id);
            if (
              !(await cancelRevokedAgentMandates(agent, "owner_revoked_agent"))
            )
              return error("service_unavailable", 503);
            await writeAudit({
              kind: "freeze",
              actor: userId,
              subjectId: agent.agent_id,
              summary: "User deleted agent access; history retained",
              data: { agent_id: agent.agent_id },
            });
            agent.deleted_at = now().toISOString();
            emitEvent(userId, "agent.deleted", { agent_id: agent.agent_id });
            return { statusCode: 200, body: { agent } };
          }),
        ),
      );
    },
  );

  app.get("/v1/app/payments", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    await expireDueApprovals();
    const items = [...payments.values()]
      .filter((payment) => payment.userId === userId)
      .map((payment) => ({
        payment_id: payment.paymentId,
        status: payment.status,
        amount: payment.request.amount,
        merchant: payment.merchant.name,
        approval_source: payment.approvalSource ?? null,
        created_at: payment.createdAt,
      }));
    return reply.send({ items, next_cursor: null });
  });

  app.post<{ Params: { id: string } }>(
    "/v1/app/payments/:id/report-dispute",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      return send(
        reply,
        await idem(userId, request, () =>
          serializePaymentSubmission(userId, async () => {
            const payment = payments.get(request.params.id);
            if (
              !payment ||
              payment.userId !== userId ||
              payment.status !== "paid"
            )
              return error("not_found", 404);
            const agent = agents.get(payment.agentId);
            if (!agent) return error("not_found", 404);
            const disputeId = `dsp_${payment.paymentId}`;
            try {
              const report = await recordTrustEvent(
                agent,
                "dispute_reported",
                disputeId,
                "Owner reported a paid purchase dispute",
              );
              await flagTrust(
                agent,
                disputeId,
                "Owner reported a paid purchase dispute",
              );
              return {
                statusCode: 200,
                body: {
                  dispute_id: disputeId,
                  trust_event: report,
                  agent: agentWithIdleState(agent),
                },
              };
            } catch {
              return error("reconciliation_required", 503);
            }
          }),
        ),
      );
    },
  );

  app.post("/v1/internal/drills/result", async (request, reply) => {
    if (!(await deps.authenticateDrillService?.(request)))
      return send(reply, error("bad_signature", 401));
    const body = request.body as {
      agent_id?: unknown;
      drill_id?: unknown;
      passed?: unknown;
      evidence_hash?: unknown;
    } | null;
    if (
      typeof body?.agent_id !== "string" ||
      typeof body.drill_id !== "string" ||
      body.passed !== true ||
      typeof body.evidence_hash !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(body.evidence_hash)
    )
      return send(reply, error("invalid_request", 400));
    const drillId = body.drill_id;
    const evidenceHash = body.evidence_hash;
    const agent = agents.get(body.agent_id);
    if (!agent) return send(reply, error("not_found", 404));
    return send(
      reply,
      await serializePaymentSubmission(agent.user_id, async () => {
        try {
          const prior = trustEvents.find(
            (item) =>
              item.agent_id === agent.agent_id &&
              item.kind === "drill_passed" &&
              item.source_id === drillId,
          );
          if (prior && prior.evidence_hash !== evidenceHash)
            return error("action_changed", 409);
          if (prior)
            return {
              statusCode: 200,
              body: { trust_event: prior, agent: agentWithIdleState(agent) },
            };
          const event = await recordTrustEvent(
            agent,
            "drill_passed",
            drillId,
            "Authenticated bank drill passed",
            undefined,
            false,
            evidenceHash,
          );
          await maybePromoteAmber(agent);
          return {
            statusCode: 200,
            body: { trust_event: event, agent: agentWithIdleState(agent) },
          };
        } catch {
          return error("reconciliation_required", 503);
        }
      }),
    );
  });

  app.post<{ Params: { id: string } }>(
    "/v1/internal/disputes/:id/uphold",
    async (request, reply) => {
      if (!(await deps.authenticateBankOperator?.(request)))
        return send(reply, error("bad_signature", 401));
      const report = trustEvents.find(
        (item) =>
          item.kind === "dispute_reported" &&
          item.source_id === request.params.id,
      );
      if (!report) return send(reply, error("not_found", 404));
      const body = request.body as { evidence_hash?: unknown } | null;
      if (
        typeof body?.evidence_hash !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test(body.evidence_hash)
      )
        return send(reply, error("invalid_request", 400));
      const evidenceHash = body.evidence_hash;
      const agent = agents.get(report.agent_id);
      if (!agent) return send(reply, error("not_found", 404));
      return send(
        reply,
        await serializePaymentSubmission(agent.user_id, async () => {
          try {
            const prior = trustEvents.find(
              (item) =>
                item.agent_id === agent.agent_id &&
                item.kind === "dispute_upheld" &&
                item.source_id === report.source_id,
            );
            if (prior && prior.evidence_hash !== evidenceHash)
              return error("action_changed", 409);
            const event = await recordTrustEvent(
              agent,
              "dispute_upheld",
              report.source_id,
              "Bank upheld owner purchase dispute",
              "RED",
              false,
              evidenceHash,
            );
            return {
              statusCode: 200,
              body: { trust_event: event, agent: agentWithIdleState(agent) },
            };
          } catch {
            return error("reconciliation_required", 503);
          }
        }),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/app/agents/:id/freeze",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      return send(
        reply,
        await idem(userId, request, async () => {
          const agent = agents.get(request.params.id);
          if (!agent || agent.user_id !== userId)
            return error("policy_denied", 403);
          if (agent.status === "revoked" || agent.deleted_at)
            return error("action_changed", 409);
          agent.status = "frozen";
          invalidateIdleRecovery(agent.agent_id);
          agentAuth.revokeAccess(agent.agent_id);
          emitEvent(userId, "agent.frozen", {
            agent_id: agent.agent_id,
            reason: "user",
          });
          await writeAudit({
            kind: "freeze",
            actor: userId,
            subjectId: agent.agent_id,
            summary: "User froze agent",
            data: { agent_id: agent.agent_id, status: "frozen" },
          });
          return { statusCode: 200, body: { agent } };
        }),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/app/approvals/:id/decide",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      return send(
        reply,
        await idem(userId, request, () =>
          serializePaymentSubmission(userId, () =>
            decideApproval(userId, request.params.id, request.body),
          ),
        ),
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/app/payments/:id",
    async (request, reply) => {
      const userId = await appUser(request);
      if (!userId) return send(reply, error("bad_signature", 401));
      await expireDueApprovals();
      const payment = payments.get(request.params.id);
      if (!payment || payment.userId !== userId)
        return send(reply, error("policy_denied", 403));
      if (
        payment.status === "reconciliation_required" ||
        payment.status === "settling"
      )
        return send(reply, reconciliationError(payment));
      return reply.send(
        PaymentStatusResponseSchema.parse({
          payment_id: payment.paymentId,
          status: payment.status,
          decision: payment.decision,
          ...(payment.receipt ? { receipt: payment.receipt } : {}),
        }),
      );
    },
  );

  app.get("/v1/app/audit", async (request, reply) => {
    const userId = await appUser(request);
    if (!userId) return send(reply, error("bad_signature", 401));
    const ownAgents = new Set(
      [...agents.values()]
        .filter((agent) => agent.user_id === userId)
        .map((agent) => agent.agent_id),
    );
    const items = audits.filter(
      (audit) => audit.actor === userId || ownAgents.has(audit.actor),
    );
    return reply.send({ items, next_cursor: null });
  });

  return app;
}
