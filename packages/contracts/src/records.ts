import { z } from "zod";
import {
  AgentIdSchema,
  AgentScopeSchema,
  ApprovalIdSchema,
  ApprovalLevelSchema,
  AuditIdSchema,
  CheckResultSchema,
  ClientAppNameSchema,
  CommitmentIdSchema,
  DateSchema,
  DecisionIdSchema,
  HashSchema,
  LicenceLevelSchema,
  MandateIdSchema,
  MerchantIdSchema,
  MoneySchema,
  NonEmptyStringSchema,
  OrderIdSchema,
  OutcomeSchema,
  PaymentIdSchema,
  PositiveMoneySchema,
  ProposalIdSchema,
  ReceiptIdSchema,
  TimestampSchema,
  TransactionHashSchema,
  UserIdSchema,
} from "./common.js";

export const TrustLightSchema = LicenceLevelSchema;
export const TrustEventSchema = z
  .object({
    schema: z.literal("trust_event.v1"),
    event_id: z.string().regex(/^tev_[A-Za-z0-9_-]+$/),
    agent_id: AgentIdSchema,
    kind: z.enum([
      "clean_purchase",
      "flag",
      "drill_passed",
      "drill_failed",
      "dispute_reported",
      "dispute_upheld",
      "transition",
      "demo_override",
    ]),
    source_id: NonEmptyStringSchema,
    evidence_hash: HashSchema.optional(),
    from: TrustLightSchema.optional(),
    to: TrustLightSchema.optional(),
    reason: NonEmptyStringSchema,
    occurred_at: TimestampSchema,
    confirmed_at: TimestampSchema.optional(),
    audit_hash: HashSchema,
    chain_tx: TransactionHashSchema.optional(),
  })
  .strict();
export type TrustEvent = z.infer<typeof TrustEventSchema>;

const CurrentAgentSchema = z
  .object({
    schema: z.literal("agent.v1"),
    agent_id: AgentIdSchema,
    user_id: UserIdSchema,
    display_name: NonEmptyStringSchema,
    provider: NonEmptyStringSchema,
    client_app_id: z
      .string()
      .regex(/^app_[0-9a-f]{64}$/)
      .nullable()
      .optional(),
    client_app_name: ClientAppNameSchema.nullable().optional(),
    public_key: z.string().startsWith("p256:").min(6),
    scopes: z.array(AgentScopeSchema),
    licence: z
      .object({
        level: LicenceLevelSchema,
        clean_purchases: z.number().int().safe().nonnegative(),
        drills_passed: z.number().int().safe().nonnegative(),
        drills_failed: z.number().int().safe().nonnegative(),
        flags_30d: z.number().int().safe().nonnegative(),
        reason: NonEmptyStringSchema,
        updated_at: TimestampSchema,
        legacy_points: z.number().int().safe().optional(),
      })
      .strict(),
    status: z.enum(["active", "frozen", "revoked"]),
    legacy_red_evidence: z
      .object({
        kind: z.literal("legacy_red"),
        reason: NonEmptyStringSchema,
        created_at: TimestampSchema,
        audit_ids: z.array(NonEmptyStringSchema).optional(),
      })
      .strict()
      .optional(),
    lineage: z
      .object({
        root_agent_id: AgentIdSchema,
        replaces_agent_id: AgentIdSchema.nullable(),
        replaced_by_agent_id: AgentIdSchema.nullable(),
      })
      .strict()
      .optional(),
    deleted_at: TimestampSchema.nullable().optional(),
    created_at: TimestampSchema,
    last_used_at: TimestampSchema.nullable(),
  })
  .strict();
/** Old durable agents remain readable without assigning them newly earned trust. */
export const AgentSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (
    !record.licence ||
    typeof record.licence !== "object" ||
    Array.isArray(record.licence)
  )
    return value;
  const licence = record.licence as Record<string, unknown>;
  const old = licence.level;
  if (old !== "L" && old !== "P" && old !== "FULL" && old !== "SUSPENDED")
    return value;
  const level = old === "L" ? "AMBER" : old === "SUSPENDED" ? "RED" : "GREEN";
  return {
    ...record,
    ...(old === "SUSPENDED"
      ? {
          legacy_red_evidence: {
            kind: "legacy_red",
            reason:
              typeof licence.reason === "string" && licence.reason.length > 0
                ? licence.reason
                : "Historical SUSPENDED licence state",
            created_at:
              typeof licence.updated_at === "string"
                ? licence.updated_at
                : record.created_at,
          },
        }
      : {}),
    licence: {
      level,
      clean_purchases: licence.clean_purchases,
      drills_passed: licence.drills_passed,
      drills_failed: 0,
      flags_30d: 0,
      reason: `Migrated legacy ${old} licence; prior history retained`,
      updated_at: record.created_at,
      ...(typeof licence.points === "number"
        ? { legacy_points: licence.points }
        : {}),
    },
  };
}, CurrentAgentSchema);
export type Agent = z.infer<typeof AgentSchema>;

export const PolicySchema = z
  .object({
    schema: z.literal("policy.v1"),
    user_id: UserIdSchema,
    per_payment_max: PositiveMoneySchema,
    daily_max: PositiveMoneySchema,
    monthly_max: PositiveMoneySchema,
    auto_approve_below: MoneySchema,
    blocked_categories: z.array(NonEmptyStringSchema),
    new_merchant_requires_tap: z.boolean(),
    treasurer: z
      .object({
        enabled: z.boolean(),
        buffer_target: MoneySchema,
        daily_topup_ceiling: MoneySchema,
        monthly_topup_ceiling: MoneySchema,
        protected_main_balance: MoneySchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const amounts = [
      policy.daily_max,
      policy.monthly_max,
      policy.auto_approve_below,
      policy.treasurer.buffer_target,
      policy.treasurer.daily_topup_ceiling,
      policy.treasurer.monthly_topup_ceiling,
      policy.treasurer.protected_main_balance,
    ];
    if (
      amounts.some(
        (money) => money.currency !== policy.per_payment_max.currency,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Policy money currencies must match",
      });
    }
  });
export type Policy = z.infer<typeof PolicySchema>;

export const AmountRangeConstraintSchema = z
  .object({ type: z.literal("amount_range"), max: PositiveMoneySchema })
  .strict();
export const CategoriesConstraintSchema = z
  .object({
    type: z.literal("categories"),
    allowed: z.array(NonEmptyStringSchema).min(1),
  })
  .strict();
export const AllowedMerchantsConstraintSchema = z
  .object({
    type: z.literal("allowed_merchants"),
    merchant_ids: z.array(MerchantIdSchema).min(1).nullable(),
  })
  .strict();
export const ProductConstraintSchema = z
  .object({
    type: z.literal("product"),
    brand: NonEmptyStringSchema.nullable(),
    model: NonEmptyStringSchema.nullable(),
    variant: NonEmptyStringSchema.nullable(),
    condition: NonEmptyStringSchema.nullable(),
    gtin: NonEmptyStringSchema.nullable(),
    skus: z.array(NonEmptyStringSchema).min(1).nullable(),
    qty: z.number().int().safe().positive(),
  })
  .strict();
export const MustHaveConstraintSchema = z
  .object({
    type: z.literal("must_have"),
    attributes: z.array(NonEmptyStringSchema).min(1),
  })
  .strict();
export const RecurrenceConstraintSchema = z
  .object({
    type: z.literal("recurrence"),
    frequency: z.enum(["NONE", "DAILY", "WEEKLY", "MONTHLY"]),
    max_occurrences: z.number().int().safe().positive(),
  })
  .strict();
export const BudgetConstraintSchema = z
  .object({ type: z.literal("budget"), max: PositiveMoneySchema })
  .strict();
export const ExecutionWindowConstraintSchema = z
  .object({
    type: z.literal("execution_window"),
    not_before: TimestampSchema.nullable(),
    not_after: TimestampSchema,
  })
  .strict();

export const MandateConstraintSchema = z.discriminatedUnion("type", [
  AmountRangeConstraintSchema,
  CategoriesConstraintSchema,
  AllowedMerchantsConstraintSchema,
  ProductConstraintSchema,
  MustHaveConstraintSchema,
  RecurrenceConstraintSchema,
  BudgetConstraintSchema,
  ExecutionWindowConstraintSchema,
]);
export type MandateConstraint = z.infer<typeof MandateConstraintSchema>;
export const MandateConstraintsSchema = z
  .array(MandateConstraintSchema)
  .min(1)
  .superRefine((constraints, ctx) => {
    const types = constraints.map((constraint) => constraint.type);
    for (const required of [
      "amount_range",
      "categories",
      "budget",
      "recurrence",
      "execution_window",
    ] as const) {
      if (!types.includes(required))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Missing ${required} constraint`,
        });
    }
    if (new Set(types).size !== types.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Constraint types must be unique",
      });
    }
    const window = constraints.find(
      (constraint) => constraint.type === "execution_window",
    );
    const recurrence = constraints.find(
      (constraint) => constraint.type === "recurrence",
    );
    if (recurrence?.frequency === "NONE" && recurrence.max_occurrences !== 1)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Non-recurring mandates allow exactly one occurrence",
      });
    if (
      window?.not_before &&
      Date.parse(window.not_before) >= Date.parse(window.not_after)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Execution window must end after it starts",
      });
    }
  });

export const MandateSchema = z
  .object({
    schema: z.literal("mandate.v1"),
    mandate_id: MandateIdSchema,
    agent_id: AgentIdSchema,
    agent_key_binding: z.string().startsWith("p256:").min(6),
    description: NonEmptyStringSchema,
    intent_level: z.enum(["open", "product", "listing"]),
    /** Missing only on records created before checkout-bound consent existed. */
    approval_timing: z.enum(["payment", "upfront"]).optional(),
    user_text: NonEmptyStringSchema,
    user_text_source: z.enum(["webank_screen", "agent_reported"]),
    constraints: MandateConstraintsSchema,
    status: z.enum([
      "pending_checkout",
      "pending_user",
      "active",
      "exhausted",
      "expired",
      "cancelled",
    ]),
    spent: MoneySchema,
    occurrences: z.number().int().safe().nonnegative(),
    in_flight_payment_id: PaymentIdSchema.nullable(),
    approved_by: z
      .enum([
        "auto_threshold",
        "user_biometric",
        "user_biometric_matched",
        "demo_simulation",
      ])
      .nullable(),
    created_at: TimestampSchema,
  })
  .strict()
  .superRefine((mandate, ctx) => {
    const recurrence = mandate.constraints.find(
      (item) => item.type === "recurrence",
    );
    if (
      mandate.approval_timing === "payment" &&
      (recurrence?.frequency !== "NONE" || recurrence.max_occurrences !== 1)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approval_timing"],
        message: "Payment-timed mandate must be single-use",
      });
    }
    if (
      mandate.status === "pending_checkout" &&
      (mandate.approval_timing !== "payment" || mandate.approved_by !== null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Checkout-bound mandate must be unapproved",
      });
    }
    if (
      mandate.approval_timing === "payment" &&
      mandate.status === "pending_user"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "Payment-timed mandate cannot have an upfront approval",
      });
    }
    if (mandate.status === "pending_user" && mandate.approved_by !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approved_by"],
        message: "Pending mandate cannot claim an approval",
      });
    }
    if (
      (mandate.status === "active" || mandate.status === "exhausted") &&
      mandate.approved_by === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approved_by"],
        message: "Active or exhausted mandate requires an approval source",
      });
    }
    if (mandate.intent_level === "product") {
      const product = mandate.constraints.find(
        (item) => item.type === "product",
      );
      if (!product || !(product.gtin || (product.brand && product.model))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["constraints"],
          message: "Product intent requires GTIN or brand and model",
        });
      }
    }
    if (mandate.intent_level === "listing") {
      const merchant = mandate.constraints.find(
        (item) => item.type === "allowed_merchants",
      );
      const product = mandate.constraints.find(
        (item) => item.type === "product",
      );
      if (!merchant?.merchant_ids || !product?.skus) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["constraints"],
          message: "Listing intent requires locked merchant IDs and SKUs",
        });
      }
    }
  });
export type Mandate = z.infer<typeof MandateSchema>;

export const ShippingAddressSchema = z
  .object({
    name: NonEmptyStringSchema,
    phone: z
      .string()
      .trim()
      .regex(/^[+0-9() -]{6,24}$/),
    address_line: NonEmptyStringSchema,
    city: NonEmptyStringSchema,
    postcode: NonEmptyStringSchema,
  })
  .strict();
export type ShippingAddress = z.infer<typeof ShippingAddressSchema>;

export const SignedProductLineItemSchema = z
  .object({
    type: z.literal("product"),
    sku: NonEmptyStringSchema,
    gtin: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    condition: NonEmptyStringSchema,
    variant: NonEmptyStringSchema,
    options: z
      .object({
        colour: NonEmptyStringSchema.optional(),
        size: NonEmptyStringSchema.optional(),
      })
      .strict(),
    qty: z.number().int().safe().positive(),
    unit_price: PositiveMoneySchema,
  })
  .strict();
export const SignedShippingLineItemSchema = z
  .object({
    type: z.literal("shipping"),
    name: NonEmptyStringSchema,
    qty: z.literal(1),
    unit_price: MoneySchema,
  })
  .strict();
export const SignedLineItemSchema = z.discriminatedUnion("type", [
  SignedProductLineItemSchema,
  SignedShippingLineItemSchema,
]);
export const PaymentRequestSchema = z
  .object({
    schema: z.literal("payreq.v1"),
    merchant_id: MerchantIdSchema,
    order_id: OrderIdSchema,
    amount: PositiveMoneySchema,
    line_items: z.array(SignedLineItemSchema).min(1),
    expires_at: TimestampSchema,
    nonce: NonEmptyStringSchema,
    merchant_sig: NonEmptyStringSchema,
  })
  .strict()
  .refine(
    (request) =>
      request.line_items.every(
        (item) => item.unit_price.currency === request.amount.currency,
      ),
    {
      message: "Line item currencies must match payment currency",
      path: ["line_items"],
    },
  )
  .refine(
    (request) => request.line_items.some((item) => item.type === "product"),
    {
      message: "Payment request needs a product line",
      path: ["line_items"],
    },
  )
  .refine(
    (request) =>
      request.line_items.filter((item) => item.type === "shipping").length ===
      1,
    {
      message: "Payment request requires one shipping line",
      path: ["line_items"],
    },
  );
export type PaymentRequest = z.infer<typeof PaymentRequestSchema>;

export const DecisionCheckSchema = z
  .object({
    name: z.enum([
      "agent_auth",
      "rail_validation",
      "mandate",
      "policy_licence",
      "risk",
      "guardian",
    ]),
    result: CheckResultSchema,
    detail: z.record(z.unknown()).optional(),
    signals: z.array(NonEmptyStringSchema).optional(),
  })
  .strict();
export const RiskSignalSchema = z
  .object({
    type: NonEmptyStringSchema,
    score: z.number().finite(),
    action: NonEmptyStringSchema,
  })
  .strict();
export const DecisionSchema = z
  .object({
    schema: z.literal("decision.v1"),
    decision_id: DecisionIdSchema,
    payment_id: PaymentIdSchema,
    outcome: OutcomeSchema,
    autonomy_level: z.enum(["L0", "L1", "L2", "L3"]),
    checks: z.array(DecisionCheckSchema),
    risk_signals: z.array(RiskSignalSchema),
    user_explanation: NonEmptyStringSchema,
    created_at: TimestampSchema,
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;

export const ReceiptSchema = z
  .object({
    schema: z.literal("receipt.v1"),
    receipt_id: ReceiptIdSchema,
    payment_id: PaymentIdSchema,
    decision_id: DecisionIdSchema,
    mandate_id: MandateIdSchema,
    merchant_id: MerchantIdSchema,
    merchant_legal_name: NonEmptyStringSchema,
    merchant_uscc: NonEmptyStringSchema,
    order_id: OrderIdSchema,
    amount: PositiveMoneySchema,
    outcome: z.enum(["APPROVED", "DENIED"]),
    chain: z
      .object({
        network: NonEmptyStringSchema,
        payment_tx: TransactionHashSchema.optional(),
        audit_tx: TransactionHashSchema,
      })
      .strict(),
    issued_at: TimestampSchema,
    webank_sig: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (receipt.outcome === "APPROVED" && !receipt.chain.payment_tx) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chain", "payment_tx"],
        message: "Approved receipt requires payment transaction",
      });
    }
    if (receipt.outcome === "DENIED" && receipt.chain.payment_tx) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["chain", "payment_tx"],
        message: "Denied receipt cannot have payment transaction",
      });
    }
  });
export type Receipt = z.infer<typeof ReceiptSchema>;

export const ApprovalSchema = z
  .object({
    schema: z.literal("approval.v1"),
    approval_id: ApprovalIdSchema,
    kind: z.enum([
      "payment",
      "mandate",
      "pairing",
      "policy_loosen",
      "treasurer_schedule",
      "emergency_topup",
      "unfreeze",
    ]),
    subject_id: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    lines: z.array(NonEmptyStringSchema).min(1),
    payload_hash: HashSchema,
    trust_light: TrustLightSchema.optional(),
    trust_reason: NonEmptyStringSchema.optional(),
    review_schema: z.literal("payment_review.v1").optional(),
    level: ApprovalLevelSchema,
    expires_at: TimestampSchema,
    status: z.enum(["pending", "approved", "rejected", "expired"]),
  })
  .strict();
export type Approval = z.infer<typeof ApprovalSchema>;

export const CommitmentSchema = z
  .object({
    schema: z.literal("commitment.v1"),
    commitment_id: CommitmentIdSchema,
    payee_merchant_id: MerchantIdSchema,
    label: NonEmptyStringSchema,
    amount: PositiveMoneySchema,
    frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
    next_due: DateSchema,
    source: z.enum(["detected_from_settled", "user_created"]),
    status: z.enum(["proposed", "active", "paused", "cancelled"]),
  })
  .strict();
export type Commitment = z.infer<typeof CommitmentSchema>;

export const FundingProposalSchema = z
  .object({
    schema: z.literal("funding_proposal.v1"),
    proposal_id: ProposalIdSchema,
    commitments: z.array(CommitmentIdSchema).min(1),
    buffer_target: MoneySchema,
    schedule: z
      .array(
        z
          .object({
            commitment_id: CommitmentIdSchema,
            fund_at: TimestampSchema,
            amount: PositiveMoneySchema,
          })
          .strict(),
      )
      .min(1),
    rationale: NonEmptyStringSchema,
    status: z.enum(["pending_user", "approved", "rejected", "expired"]),
  })
  .strict();
export type FundingProposal = z.infer<typeof FundingProposalSchema>;

export const AuditRecordSchema = z
  .object({
    schema: z.literal("audit.v1"),
    audit_id: AuditIdSchema,
    kind: z.enum([
      "pairing",
      "mandate",
      "payment_decision",
      "funding",
      "freeze",
      "licence_change",
      "drill",
      "policy_change",
      "monitor_alert",
    ]),
    actor: NonEmptyStringSchema,
    subject_id: NonEmptyStringSchema,
    summary: NonEmptyStringSchema,
    record_hash: HashSchema,
    chain_tx: TransactionHashSchema,
    created_at: TimestampSchema,
  })
  .strict();
export type AuditRecord = z.infer<typeof AuditRecordSchema>;
