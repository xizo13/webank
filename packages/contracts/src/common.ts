import { z } from "zod";

/** Money is always an integer number of minor units. No float conversion occurs here. */
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
export const MoneySchema = z
  .object({
    amount: z.number().int().safe().nonnegative(),
    currency: CurrencySchema,
  })
  .strict();
export const PositiveMoneySchema = MoneySchema.extend({
  amount: z.number().int().safe().positive(),
});
export type Money = z.infer<typeof MoneySchema>;

export const TimestampSchema = z.string().datetime({ offset: true });
export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const HashSchema = z.string().regex(/^sha256:[0-9a-fA-F]{64}$/);
export const TransactionHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const NonEmptyStringSchema = z.string().trim().min(1);

export function idSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9][A-Za-z0-9_-]*$`));
}

export const UserIdSchema = idSchema("usr");
export const AgentIdSchema = idSchema("agt");
export const MandateIdSchema = idSchema("mdt");
export const PaymentIdSchema = idSchema("pay");
export const DecisionIdSchema = idSchema("dec");
export const ReceiptIdSchema = idSchema("rcp");
export const ApprovalIdSchema = idSchema("apr");
export const AuditIdSchema = idSchema("aud");
export const CommitmentIdSchema = idSchema("cmt");
export const ProposalIdSchema = idSchema("prp");
export const OrderIdSchema = idSchema("ord");
export const MerchantIdSchema = idSchema("mch");

export const AgentScopeSchema = z.enum([
  "wallet:pay",
  "wallet:mandate",
  "wallet:history:self",
  "wallet:balance",
]);
export const LicenceLevelSchema = z.enum(["L", "P", "FULL", "SUSPENDED"]);
export const OutcomeSchema = z.enum(["APPROVED", "STEP_UP", "DENIED"]);
export const CheckResultSchema = z.enum(["pass", "step_up", "deny", "skipped"]);
export const PaymentStatusSchema = z.enum(["paid", "awaiting_user", "denied"]);
export const ApprovalLevelSchema = z.enum(["zero_trust", "everyday", "in_app"]);
export const RequestNumberSchema = z.string().regex(/^\d{6}$/);
export const DEFAULT_APPROVAL_TTL_SECONDS = 180;

/** Compute the default approval deadline; Gateway may override the TTL by configuration. */
export function approvalExpiresAt(
  createdAt: string,
  ttlSeconds = DEFAULT_APPROVAL_TTL_SECONDS,
): string {
  const timestamp = TimestampSchema.parse(createdAt);
  const ttl = z.number().int().safe().positive().parse(ttlSeconds);
  return new Date(Date.parse(timestamp) + ttl * 1000).toISOString();
}

export const VerificationSchema = z
  .object({
    action_hash: HashSchema,
    device_signature: NonEmptyStringSchema,
    request_number: RequestNumberSchema.optional(),
  })
  .strict();
export type Verification = z.infer<typeof VerificationSchema>;
export const EverydayVerificationSchema = VerificationSchema.omit({
  request_number: true,
});
export const ZeroTrustVerificationSchema = VerificationSchema.extend({
  request_number: RequestNumberSchema,
});

export const ErrorCodeSchema = z.enum([
  "bad_signature",
  "token_expired",
  "agent_frozen",
  "scope_missing",
  "mandate_not_found",
  "mandate_expired",
  "mandate_exhausted",
  "mandate_in_flight",
  "payreq_invalid",
  "merchant_unknown",
  "idempotency_conflict",
  "policy_denied",
  "reconciliation_required",
  "guardian_denied",
  "rate_limited",
]);
export const ErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: ErrorCodeSchema,
        message: NonEmptyStringSchema.optional(),
        decision_id: DecisionIdSchema.optional(),
        payment_id: PaymentIdSchema.optional(),
        payment_tx: TransactionHashSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const PaginationQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: NonEmptyStringSchema.optional(),
  })
  .strict();

export function pageSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z
    .object({ items: z.array(itemSchema), next_cursor: z.string().nullable() })
    .strict();
}
