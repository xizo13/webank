import {
  createPublicKey,
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto";
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
  GuardianInputSchema,
  GuardianVerdictSchema,
  MandateResponseSchema,
  MandateSchema,
  PaidPaymentResponseSchema,
  PaymentHistoryResponseSchema,
  type PaymentRequest,
  PaymentStatusResponseSchema,
  PolicySchema,
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
import type {
  GatewayDependencies,
  GatewaySeed,
  StoredPayment,
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
};
type AppEvent = {
  id: number;
  type: string;
  data: unknown;
  created_at: string;
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

/** In-memory vertical slice. Inject real authentication, funds, chain and signing adapters. */
export function createGateway(deps: GatewayDependencies, seed: GatewaySeed) {
  if (process.env.NODE_ENV === "production" && deps.demoApprovalsEnabled)
    throw new Error("Demo approval proofs are forbidden in production");
  const app = Fastify({ logger: false });
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
  const payments = new Map<string, StoredPayment>();
  const usedMerchantNonces = new Set<string>();
  const audits: AuditRecord[] = [];
  const eventsByUser = new Map<string, AppEvent[]>();
  const idempotency = new Map<
    string,
    { bodyHash: string; result: Promise<Response> }
  >();
  const expiryTimers = new Set<ReturnType<typeof setTimeout>>();
  app.addHook("onClose", async () => {
    for (const timer of expiryTimers) clearTimeout(timer);
    expiryTimers.clear();
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
      registered.licence.level === "SUSPENDED"
    )
      return { response: error("agent_frozen", 401) };
    if (!registered.scopes.includes(scope))
      return { response: error("scope_missing", 403) };
    return { agent: registered };
  }

  async function appUser(request: FastifyRequest) {
    try {
      return await deps.authenticateApp(request);
    } catch {
      return null;
    }
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
    const result = Promise.resolve()
      .then(run)
      .catch(() => error("policy_denied", 503));
    idempotency.set(mapKey, { bodyHash, result });
    return result;
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
    const delay = Math.max(
      0,
      Date.parse(entry.card.expires_at) - now().getTime(),
    );
    const timer = setTimeout(() => {
      expiryTimers.delete(timer);
      void expireApproval(entry).catch((failure: unknown) => {
        app.log.error({ failure }, "Approval expiry requires reconciliation");
      });
    }, delay);
    timer.unref();
    expiryTimers.add(timer);
  }

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
  ): Promise<Response> {
    const mandate = mandates.get(payment.mandateId);
    if (!mandate) return error("mandate_not_found", 403);
    try {
      if (outcome === "APPROVED") {
        const currentAgent = agents.get(payment.agentId);
        const currentMerchant = await deps.lookupMerchant(
          payment.merchant.merchant_id,
        );
        if (
          currentAgent?.status !== "active" ||
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
      }
      let paymentTx: `0x${string}` | undefined;
      if (outcome === "APPROVED") {
        paymentTx = await deps.executePayment({
          paymentId: payment.paymentId,
          mandate,
          request: payment.request,
          merchant: payment.merchant,
        });
        payment.settlementTx = paymentTx;
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
      return {
        statusCode: 403,
        body: DeniedPaymentResponseSchema.parse({
          payment_id: payment.paymentId,
          status: "denied",
          decision: payment.decision,
          receipt: payment.receipt,
        }),
      };
    } catch {
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
      if (mandate) mandate.status = "cancelled";
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
    data: unknown,
  ): Promise<Response> {
    const decisionId = id("dec");
    await writeAudit({
      kind: "payment_decision",
      actor: agent.agent_id,
      subjectId: decisionId,
      summary: `DENIED before a verified payment request: ${code}`,
      data,
    });
    return error(code, statusCode, decisionId);
  }

  async function submitPayment(agent: Agent, raw: unknown): Promise<Response> {
    const parsed = CreatePaymentRequestSchema.safeParse(raw);
    if (!parsed.success) return error("payreq_invalid", 400);
    const body = parsed.data;
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
    const mandate = mandates.get(body.mandate_id);
    if (
      !mandate ||
      mandate.agent_id !== agent.agent_id ||
      mandate.agent_key_binding !== agent.public_key
    )
      return rejectedAttempt(agent, "mandate_not_found", 403, {
        mandate_id: body.mandate_id,
      });
    if (mandate.in_flight_payment_id) return error("mandate_in_flight", 409);
    const nonceKey = `${paymentRequest.merchant_id}:${paymentRequest.nonce}`;
    if (usedMerchantNonces.has(nonceKey))
      return rejectedAttempt(agent, "payreq_invalid", 400, {
        merchant_id: paymentRequest.merchant_id,
        order_id: paymentRequest.order_id,
        reason: "merchant_nonce_reused",
      });
    usedMerchantNonces.add(nonceKey);

    const paymentId = id("pay");
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
      const policy = policies.get(agent.user_id);
      let policyCheck: Check = checks.some((check) => check.result === "deny")
        ? { name: "policy_licence", result: "skipped" }
        : {
            name: "policy_licence",
            result: "deny",
            detail: { reason: "policy_missing" },
          };
      if (policy && policyCheck.result !== "skipped") {
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
        const duplicate = [...payments.values()].some(
          (item) =>
            item.request.merchant_id === paymentRequest.merchant_id &&
            item.request.order_id === paymentRequest.order_id &&
            item.status !== "denied",
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
              detail: { explanation: assessment.explanation },
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
          `For: ${paymentRequest.line_items.map((item) => `${item.qty} x ${item.name}`).join(", ")}`,
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
    const parsed = CreateMandateRequestSchema.safeParse(raw);
    if (!parsed.success) return error("policy_denied", 400);
    const policy = policies.get(agent.user_id);
    if (!policy) return error("policy_denied", 403);
    const constraints = parsed.data.constraints;
    const budget = constraints.find((item) => item.type === "budget");
    const amountRange = constraints.find(
      (item) => item.type === "amount_range",
    );
    const recurrence = constraints.find((item) => item.type === "recurrence");
    const window = constraints.find((item) => item.type === "execution_window");
    const categories = constraints.find((item) => item.type === "categories");
    if (!budget || !amountRange || !recurrence || !window || !categories)
      return error("policy_denied", 403);
    if (
      budget.max.currency !== policy.per_payment_max.currency ||
      amountRange.max.currency !== policy.per_payment_max.currency ||
      Date.parse(window.not_after) <= now().getTime()
    )
      return error("policy_denied", 403);
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
    const mandate = MandateSchema.parse({
      schema: "mandate.v1",
      mandate_id: mandateId,
      agent_id: agent.agent_id,
      agent_key_binding: agent.public_key,
      description: parsed.data.description,
      intent_level: mandateIntentLevel(constraints),
      user_text: parsed.data.description,
      user_text_source: "agent_reported",
      constraints,
      status: auto ? "active" : "pending_user",
      spent: { amount: 0, currency: budget.max.currency },
      occurrences: 0,
      in_flight_payment_id: null,
      approved_by: auto ? "auto_threshold" : null,
      created_at: now().toISOString(),
    });
    if (auto) {
      if (!(await deps.reserveMandate(mandate)))
        return error("policy_denied", 403);
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
    const card = approvalCard(
      "mandate",
      "everyday",
      mandateId,
      `${agent.display_name} requests a spending mandate`,
      [
        `Agent request: ${parsed.data.description}`,
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
        constraints,
      },
    );
    mandates.set(mandateId, mandate);
    storeApproval({
      card,
      userId: agent.user_id,
      mandateId,
      numberMismatches: 0,
    });
    return {
      statusCode: 202,
      body: CreateMandateResponseSchema.parse({
        mandate,
        approval_id: card.approval_id,
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
      if (uncertain?.status === "reconciliation_required")
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
      const mandate = mandates.get(entry.mandateId);
      if (mandate?.status !== "pending_user")
        return error("mandate_not_found", 403);
      mandate.status = "active";
      mandate.approved_by = verifiedBy;
      mandate.user_text_source = "webank_screen";
      entry.card.status = "approved";
      if (!(await deps.reserveMandate(mandate))) {
        mandate.status = "pending_user";
        mandate.approved_by = null;
        mandate.user_text_source = "agent_reported";
        entry.card.status = "pending";
        return error("policy_denied", 403);
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
      if (response.statusCode === 503) return response;
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
      { userCode, ...parsed.data },
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
      return reply.send({
        approval: pairing.card,
        client_name: pairing.clientName,
        provider: pairing.provider,
        requested_scopes: pairing.scopes,
        public_key: pairing.publicKey,
      });
    },
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
          if (
            parsed.data.verification.request_number !== pairing.requestNumber
          ) {
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
              },
            });
          } catch {
            pairing.status = "pending";
            return error("policy_denied", 503);
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
        createMandate(auth.agent, request.body),
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
        return send(reply, error("mandate_not_found", 403));
      return reply.send(MandateResponseSchema.parse({ mandate }));
    },
  );

  app.post("/v1/agent/payments", async (request, reply) => {
    const auth = await agentFor(request, "wallet:pay");
    if (!auth.agent) return send(reply, auth.response as Response);
    return send(
      reply,
      await idem(auth.agent.agent_id, request, () =>
        submitPayment(auth.agent, request.body),
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
        return send(reply, error("policy_denied", 403));
      if (payment.status === "reconciliation_required")
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

  app.get("/v1/agent/payments", async (request, reply) => {
    const auth = await agentFor(request, "wallet:history:self");
    if (!auth.agent) return send(reply, auth.response as Response);
    const items = [...payments.values()]
      .filter((payment) => payment.agentId === auth.agent.agent_id)
      .filter((payment) => payment.status !== "reconciliation_required")
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
      (agent) => agent.user_id === userId,
    );
    return reply.send({ items, next_cursor: null });
  });

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
          agent.status = "frozen";
          agentAuth.revokeAgent(agent.agent_id);
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
          decideApproval(userId, request.params.id, request.body),
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
      if (payment.status === "reconciliation_required")
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
