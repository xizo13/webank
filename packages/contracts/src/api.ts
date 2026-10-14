import { z } from "zod";
import {
  AgentIdSchema,
  AgentScopeSchema,
  ApprovalIdSchema,
  MandateIdSchema,
  MoneySchema,
  NonEmptyStringSchema,
  OrderIdSchema,
  PaymentIdSchema,
  PaymentStatusSchema,
  PositiveMoneySchema,
  pageSchema,
  RequestNumberSchema,
  TimestampSchema,
  VerificationSchema,
} from "./common.js";
import {
  ApprovalSchema,
  DecisionCheckSchema,
  DecisionSchema,
  MandateConstraintSchema,
  MandateConstraintsSchema,
  MandateSchema,
  ReceiptSchema,
  RiskSignalSchema,
  SignedLineItemSchema,
} from "./records.js";

/** The signed merchant payload stays opaque to the agent until the Gateway validates it. */
export const PaymentRequestUriSchema = z
  .string()
  .regex(/^ecny:\/\/pay\?d=[A-Za-z0-9_-]+={0,2}$/);
export const IdempotencyKeySchema = z.string().min(1).max(255);

export const DeviceAuthorizationRequestSchema = z
  .object({
    client_name: NonEmptyStringSchema,
    provider: NonEmptyStringSchema,
    agent_public_key: z.string().startsWith("p256:").min(6),
    requested_scopes: z.array(AgentScopeSchema).min(1),
  })
  .strict();
export const DeviceAuthorizationResponseSchema = z
  .object({
    device_code: NonEmptyStringSchema,
    user_code: NonEmptyStringSchema,
    verification_uri: z.string().url(),
    qr_payload: NonEmptyStringSchema,
    request_number: RequestNumberSchema,
    expires_in: z.literal(600),
    interval: z.literal(3),
  })
  .strict();

export const DeviceTokenRequestSchema = z
  .object({
    grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"),
    device_code: NonEmptyStringSchema,
  })
  .strict();
export const RefreshTokenRequestSchema = z
  .object({
    grant_type: z.literal("refresh_token"),
    refresh_token: NonEmptyStringSchema,
  })
  .strict();
export const TokenRequestSchema = z.discriminatedUnion("grant_type", [
  DeviceTokenRequestSchema,
  RefreshTokenRequestSchema,
]);
export const TokenResponseSchema = z
  .object({
    access_token: NonEmptyStringSchema,
    refresh_token: NonEmptyStringSchema,
    expires_in: z.literal(900),
    agent_id: AgentIdSchema,
  })
  .strict();
export const DeviceTokenErrorSchema = z
  .object({
    error: z.enum(["authorization_pending", "access_denied", "expired_token"]),
  })
  .strict();

export const CreateMandateRequestSchema = z
  .object({
    description: NonEmptyStringSchema,
    constraints: MandateConstraintsSchema,
  })
  .strict();
export const MandateResponseSchema = z
  .object({ mandate: MandateSchema })
  .strict();
export const CreateMandateResponseSchema = z
  .object({ mandate: MandateSchema, approval_id: ApprovalIdSchema.optional() })
  .strict()
  .refine(
    (response) =>
      response.mandate.status !== "pending_user" || !!response.approval_id,
    {
      message: "Pending mandate requires approval ID",
      path: ["approval_id"],
    },
  );

export const PriceEvidenceSchema = z
  .object({
    merchant_name: NonEmptyStringSchema,
    url: z.string().url().optional(),
    price: PositiveMoneySchema,
    seen_at: TimestampSchema,
  })
  .strict();
export const CreatePaymentRequestSchema = z
  .object({
    mandate_id: MandateIdSchema,
    payment_request: PaymentRequestUriSchema,
    cart_claim: z.array(z.unknown()).optional(),
    price_evidence: z.array(PriceEvidenceSchema),
    rationale: NonEmptyStringSchema,
  })
  .strict();

export const PaidPaymentResponseSchema = z
  .object({
    payment_id: PaymentIdSchema,
    status: z.literal("paid"),
    decision: DecisionSchema,
    receipt: ReceiptSchema,
  })
  .strict()
  .refine(
    (response) =>
      response.decision.outcome === "APPROVED" &&
      response.receipt.outcome === "APPROVED" &&
      response.payment_id === response.decision.payment_id &&
      response.payment_id === response.receipt.payment_id &&
      response.decision.decision_id === response.receipt.decision_id,
    {
      message: "Paid payment must have an approved decision and receipt",
    },
  );
const AwaitingUserPaymentResponseBaseSchema = z
  .object({
    payment_id: PaymentIdSchema,
    status: z.literal("awaiting_user"),
    decision: DecisionSchema,
    approval_id: ApprovalIdSchema,
    poll_after: z.number().int().positive(),
  })
  .strict();
export const ZeroTrustPaymentResponseSchema =
  AwaitingUserPaymentResponseBaseSchema.extend({
    approval_level: z.literal("zero_trust"),
    request_number: RequestNumberSchema,
  }).refine(
    (response) =>
      response.decision.outcome === "STEP_UP" &&
      response.payment_id === response.decision.payment_id,
    { message: "Awaiting-user payment requires a STEP_UP decision" },
  );
export const EverydayPaymentResponseSchema =
  AwaitingUserPaymentResponseBaseSchema.extend({
    approval_level: z.literal("everyday"),
  }).refine(
    (response) =>
      response.decision.outcome === "STEP_UP" &&
      response.payment_id === response.decision.payment_id,
    { message: "Awaiting-user payment requires a STEP_UP decision" },
  );
export const AwaitingUserPaymentResponseSchema = z.union([
  ZeroTrustPaymentResponseSchema,
  EverydayPaymentResponseSchema,
]);
export const DeniedPaymentResponseSchema = z
  .object({
    payment_id: PaymentIdSchema,
    status: z.literal("denied"),
    decision: DecisionSchema,
    receipt: ReceiptSchema,
  })
  .strict()
  .refine(
    (response) =>
      response.decision.outcome === "DENIED" &&
      response.receipt.outcome === "DENIED" &&
      response.payment_id === response.decision.payment_id &&
      response.payment_id === response.receipt.payment_id &&
      response.decision.decision_id === response.receipt.decision_id,
    {
      message: "Denied payment must have a denied decision and receipt",
    },
  );
export const PaymentSubmissionResponseSchema = z.union([
  PaidPaymentResponseSchema,
  AwaitingUserPaymentResponseSchema,
  DeniedPaymentResponseSchema,
]);
export const PaymentStatusResponseSchema = z
  .object({
    payment_id: PaymentIdSchema,
    status: PaymentStatusSchema,
    decision: DecisionSchema,
    receipt: ReceiptSchema.optional(),
  })
  .strict()
  .superRefine((response, ctx) => {
    if (response.payment_id !== response.decision.payment_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision", "payment_id"],
        message: "Payment and decision IDs must match",
      });
    }
    if (
      response.receipt &&
      (response.payment_id !== response.receipt.payment_id ||
        response.decision.decision_id !== response.receipt.decision_id)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt"],
        message: "Receipt must match payment and decision IDs",
      });
    }
    if (response.status === "awaiting_user" && response.receipt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt"],
        message: "Pending payment cannot have a receipt",
      });
    }
    if (response.status !== "awaiting_user" && !response.receipt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt"],
        message: "Settled decision requires a receipt",
      });
    }
    const expectedOutcome = {
      paid: "APPROVED",
      awaiting_user: "STEP_UP",
      denied: "DENIED",
    }[response.status];
    if (response.decision.outcome !== expectedOutcome) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision", "outcome"],
        message: "Decision outcome must match payment status",
      });
    }
    if (
      response.receipt &&
      response.status !== "awaiting_user" &&
      response.receipt.outcome !== expectedOutcome
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receipt", "outcome"],
        message: "Receipt outcome must match payment status",
      });
    }
  });
export const PaymentHistoryItemSchema = z
  .object({
    payment_id: PaymentIdSchema,
    status: PaymentStatusSchema,
    amount: MoneySchema,
    merchant: NonEmptyStringSchema,
    created_at: TimestampSchema,
  })
  .strict();
export const PaymentHistoryResponseSchema = pageSchema(
  PaymentHistoryItemSchema,
);

export const ApprovalDecisionRequestSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    verification: VerificationSchema.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.decision === "approve" && !request.verification) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verification"],
        message: "Approval requires biometric verification",
      });
    }
    if (request.decision === "reject" && request.verification) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verification"],
        message: "Rejection does not require verification",
      });
    }
  });
export const ApprovalsResponseSchema = pageSchema(ApprovalSchema);

export const GuardianInputSchema = z
  .object({
    mandate: z
      .object({
        intent_level: z.enum(["open", "product", "listing"]),
        description: NonEmptyStringSchema,
        user_text: NonEmptyStringSchema,
        user_text_source: z.enum(["webank_screen", "agent_reported"]),
        constraints: z.array(MandateConstraintSchema),
      })
      .strict(),
    merchant_verified: z
      .object({
        name: NonEmptyStringSchema,
        category: NonEmptyStringSchema,
        first_seen: z.boolean(),
      })
      .strict(),
    signed_line_items: z.array(SignedLineItemSchema),
    deterministic_results: z.array(DecisionCheckSchema),
    untrusted: z
      .object({
        cart_claim: z.array(z.unknown()),
        rationale: z.string(),
        price_evidence: z.array(PriceEvidenceSchema),
      })
      .strict(),
    risk_signals: z.array(RiskSignalSchema),
  })
  .strict();
export const GuardianVerdictSchema = z
  .object({
    verdict: z.enum(["pass", "step_up", "deny"]),
    reasons: z.array(NonEmptyStringSchema),
    user_explanation: NonEmptyStringSchema,
  })
  .strict();

export const ShopCheckoutRequestSchema = z
  .object({ shipping_profile: z.literal("default") })
  .strict();
export const ShopCheckoutResponseSchema = z
  .object({
    order_id: OrderIdSchema,
    total: PositiveMoneySchema,
    payment_request: PaymentRequestUriSchema,
    expires_at: TimestampSchema,
  })
  .strict();
export const ShopPaymentConfirmedRequestSchema = z
  .object({
    order_id: OrderIdSchema,
    payment_tx: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  })
  .strict();

export type CreateMandateRequest = z.infer<typeof CreateMandateRequestSchema>;
export type CreatePaymentRequest = z.infer<typeof CreatePaymentRequestSchema>;
export type PaymentSubmissionResponse = z.infer<
  typeof PaymentSubmissionResponseSchema
>;
export type GuardianInput = z.infer<typeof GuardianInputSchema>;
export type GuardianVerdict = z.infer<typeof GuardianVerdictSchema>;
