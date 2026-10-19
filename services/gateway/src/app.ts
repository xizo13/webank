import {
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
  PaymentStatusResponseSchema,
  PendingMandatePaymentResponseSchema,
  PolicySchema,
  PositiveMoneySchema,
  type Receipt,
  ReceiptSchema,
  TokenRequestSchema,
  TokenResponseSchema,
} from "@webank/contracts";
import Fastify, { type FastifyRequest } from "fastify";
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
type GatewayState = {
  context: string;
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
        action: "unfreeze" | "relicense";
        actionHash: string;
        sessionBinding: string;
        challenge: string;
        expiresAt: number;
        used: boolean;
      },
    ]
  >;
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
  auth: ReturnType<AgentAuth["snapshot"]>;
};

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
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
        reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
      action: "unfreeze" | "relicense";
      actionHash: string;
      sessionBinding: string;
      challenge: string;
      expiresAt: number;
      used: boolean;
    }
  >();
  const payments = new Map<string, StoredPayment>();
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
  const replacingAgents = new Set<string>();
  const usedMerchantNonces = new Set<string>();
  const audits: AuditRecord[] = [];
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
        if (item.status === "processing") item.status = "pending";
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
      for (const value of restored.usedMerchantNonces)
        usedMerchantNonces.add(value);
      for (const value of restored.audits)
        audits.push(AuditRecordSchema.parse(value));
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
  function snapshot(): GatewayState {
    return {
      context: deps.stateContext ?? "test",
      agents: [...agents.values()],
      policies: [...policies.values()],
      mandates: [...mandates.values()],
      approvals: [...approvals],
      pairings: [...pairingByDevice.values()],
      replacingAgents: [...replacingAgents],
      replacementTickets: [...replacementTickets],
      actionChallenges: [...actionChallenges],
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
    for (const mandate of mandates.values()) {
      if (mandate.status !== "active" && mandate.status !== "pending_user")
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
        mandate.status === "pending_user"
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
      points: agent.licence.points,
      demerit_count: Math.max(0, -agent.licence.points),
      latest_reason:
        audits.filter((item) => item.subject_id === agent.agent_id).at(-1)
          ?.summary ?? null,
      root_agent_id: agent.lineage?.root_agent_id ?? agent.agent_id,
      deleted_at: agent.deleted_at ?? null,
    };
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
      registered.licence.level === "SUSPENDED" ||
      replacingAgents.has(registered.agent_id)
    )
      return { response: error("agent_frozen", 401) };
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

  function approvalCard(
    kind: "mandate" | "payment" | "pairing",
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
          replacingAgents.has(payment.agentId) ||
          currentAgent.licence.level === "SUSPENDED" ||
          mandate.in_flight_payment_id !== payment.paymentId ||
          Date.parse(payment.request.expires_at) <= now().getTime() ||
          !currentMerchant ||
          currentMerchant.public_key !== payment.merchant.public_key ||
          currentMerchant.honeypot ||
          checkMandate(mandate, payment.request, currentMerchant, now())
            .result === "deny"
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
        if (agent) agent.licence.clean_purchases++;
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
      if (
        failure instanceof ChainRevertError &&
        failure.reason === "insufficient" &&
        payment.status === "settling" &&
        !payment.settlementTx
      ) {
        try {
          const explanation =
            "The Agent Wallet does not hold enough confirmed funds.";
          payment.decision = DecisionSchema.parse({
            ...payment.decision,
            outcome: "DENIED",
            user_explanation: explanation,
          });
          payment.receipt = await makeReceipt(payment, "DENIED");
          payment.denialError = denial("insufficient_wallet_funds");
          payment.status = "denied";
          mandate.in_flight_payment_id = null;
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
      if (payment?.status === "awaiting_user")
        await settle(
          payment,
          "DENIED",
          `Approval timed out after ${ttl} seconds.`,
        );
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
    if (mandate.status === "cancelled") return agentDenied("mandate_cancelled");
    if (mandate.status === "exhausted") return agentDenied("mandate_exhausted");
    if (mandate.status === "expired") return agentDenied("mandate_expired");
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

    const paymentId = id("pay");
    if (request) {
      const mapKey = `${agent.agent_id}:${request.method}:${request.url}:${request.headers["idempotency-key"]}`;
      const entry = idempotency.get(mapKey);
      if (entry) entry.paymentId = paymentId;
    }
    mandate.in_flight_payment_id = paymentId;
    try {
      const checks: Check[] = [
        { name: "agent_auth", result: "pass" },
        {
          name: "rail_validation",
          result: merchant.honeypot ? "deny" : "pass",
          detail: {
            merchant_verified: merchant.name,
            category: merchant.category,
            honeypot: merchant.honeypot,
            ...(merchant.honeypot ? { reason: "fire_drill_decoy" } : {}),
          },
        },
      ];
      const mandateCheck: Check = checks.some(
        (check) => check.result === "deny",
      )
        ? { name: "mandate", result: "skipped" }
        : checkMandate(mandate, paymentRequest, merchant, now());
      checks.push(mandateCheck);
      let policyCheck: Check = checks.some((check) => check.result === "deny")
        ? { name: "policy_licence", result: "skipped" }
        : { name: "policy_licence", result: "pass" };
      if (policyCheck.result !== "skipped") {
        const paid = [...payments.values()].filter(
          (item) => item.userId === agent.user_id && item.status === "paid",
        );
        const paidToday = paid
          .filter(
            (item) => now().getTime() - Date.parse(item.createdAt) < 86_400_000,
          )
          .reduce((sum, item) => sum + item.request.amount.amount, 0);
        const paidMonth = paid
          .filter(
            (item) =>
              now().getTime() - Date.parse(item.createdAt) < 31 * 86_400_000,
          )
          .reduce((sum, item) => sum + item.request.amount.amount, 0);
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
            guardianCheck = { name: "guardian", result: verdict.verdict };
            guardianExplanation = verdict.user_explanation;
          } catch {
            guardianCheck = {
              name: "guardian",
              result: "step_up",
              detail: { reason: "guardian_unavailable" },
            };
            guardianExplanation =
              "We could not confirm the purchase intent. Please review it.";
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
      }
      checks.push(guardianCheck);
      const result = strictest(
        checks
          .filter((check) => check.result !== "skipped")
          .map((check) => check.result as Result),
      );
      const outcome =
        result === "deny"
          ? "DENIED"
          : result === "step_up"
            ? "STEP_UP"
            : "APPROVED";
      const deniedReason = checks.find((check) => check.result === "deny")
        ?.detail?.reason;
      const explanation =
        outcome === "DENIED"
          ? `Blocked by ${String(deniedReason ?? "verified policy")}.`
          : outcome === "STEP_UP"
            ? "Please review this payment in the WeBank app."
            : guardianExplanation;
      const decision = DecisionSchema.parse({
        schema: "decision.v1",
        decision_id: id("dec"),
        payment_id: paymentId,
        outcome,
        autonomy_level:
          agent.licence.level === "FULL"
            ? "L3"
            : agent.licence.level === "P"
              ? "L1"
              : "L0",
        checks,
        risk_signals: riskSignals,
        user_explanation: explanation,
        created_at: now().toISOString(),
      });
      const payment: StoredPayment = {
        paymentId,
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
      if (outcome === "DENIED") return settle(payment, "DENIED", explanation);
      if (outcome === "APPROVED")
        return settle(payment, "APPROVED", explanation);
      const requestNumber = firstPayment
        ? randomInt(0, 1_000_000).toString().padStart(6, "0")
        : undefined;
      const card = approvalCard(
        "payment",
        firstPayment ? "zero_trust" : "everyday",
        paymentId,
        `${agent.display_name} wants to pay ${paymentRequest.amount.amount / 100} ${paymentRequest.amount.currency}`,
        [
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
        ],
        { paymentId, mandateId: mandate.mandate_id, paymentRequest, decision },
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
    const autoCap =
      agent.licence.level === "L"
        ? 0
        : agent.licence.level === "P"
          ? Math.min(10_000, policy.auto_approve_below.amount)
          : policy.auto_approve_below.amount;
    const auto =
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
      user_text: parsed.data.user_text,
      user_text_source: "agent_reported",
      constraints,
      status: auto ? "active" : "pending_user",
      spent: { amount: 0, currency: budget.max.currency },
      occurrences: 0,
      in_flight_payment_id: null,
      approved_by: auto ? "auto_threshold" : null,
      created_at: now().toISOString(),
    });
    if (!mandateResult.success) return error("invalid_mandate", 400);
    const mandate = mandateResult.data;
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
      agent.licence.level === "L" &&
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
        agent.licence.level === "SUSPENDED" ||
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
      const paid = [...payments.values()].filter(
        (item) => item.userId === userId && item.status === "paid",
      );
      const spentToday = paid
        .filter(
          (item) => now().getTime() - Date.parse(item.createdAt) < 86_400_000,
        )
        .reduce((sum, item) => sum + item.request.amount.amount, 0);
      const spentMonth = paid
        .filter(
          (item) =>
            now().getTime() - Date.parse(item.createdAt) < 31 * 86_400_000,
        )
        .reduce((sum, item) => sum + item.request.amount.amount, 0);
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
        `Requested scopes: ${parsed.data.requested_scopes.join(", ")}`,
        `Public key: ${parsed.data.agent_public_key}`,
      ],
      {
        userCode,
        client_name: parsed.data.client_name,
        provider: parsed.data.provider,
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
      if (agent?.status !== "active" || agent.licence.level === "SUSPENDED")
        return reply.code(400).send({ error: "invalid_grant" });
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
      agent.status === "revoked"
        ? "revoked"
        : agent.status === "frozen"
          ? "frozen"
          : agent.licence.level === "SUSPENDED"
            ? "suspended"
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
            !pairing ||
            pairing.expiresAt <= now().getTime() ||
            pairing.status !== "pending"
          )
            return error("policy_denied", 403);
          if (pairing.userId !== userId) return error("policy_denied", 403);
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
            public_key: pairing.publicKey,
            scopes: pairing.scopes,
            licence: {
              level: "L",
              points: 0,
              clean_purchases: 0,
              drills_passed: 0,
            },
            status: "active",
            lineage: {
              root_agent_id: agentId,
              replaces_agent_id: null,
              replaced_by_agent_id: null,
            },
            deleted_at: null,
            created_at: now().toISOString(),
            last_used_at: null,
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
      return reply.send(MandateResponseSchema.parse({ mandate }));
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
      .map((entry) => entry.card)
      .filter((card) => status === undefined || card.status === status);
    return reply.send({ items, next_cursor: null });
  });

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
    const items = [...agents.values()].filter(
      (agent) => agent.user_id === userId && !agent.deleted_at,
    );
    return reply.send({ items, next_cursor: null });
  });

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
        return mandate.status === "active" &&
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
        (action === "relicense" && agent.licence.level !== "SUSPENDED")
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
        demerit_count: Math.max(0, -agent.licence.points),
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

  for (const action of ["unfreeze", "relicense"] as const) {
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
              demerit_count: Math.max(0, -agent.licence.points),
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
            challenge.used = true;
            if (action === "unfreeze") agent.status = "active";
            else agent.licence.level = "L";
            await writeAudit({
              kind: action === "unfreeze" ? "freeze" : "licence_change",
              actor: userId,
              subjectId: agent.agent_id,
              summary: `Local demo simulated ${action} approved by user`,
              data: { action, agent_id: agent.agent_id },
            });
            emitEvent(userId, `agent.${action}`, { agent_id: agent.agent_id });
            return { statusCode: 200, body: { agent, simulated: true } };
          }),
        );
      },
    );
  }

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
        created_at: payment.createdAt,
      }));
    return reply.send({ items, next_cursor: null });
  });

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
