import { z } from "zod";
import {
  AgentIdSchema,
  ApprovalIdSchema,
  CommitmentIdSchema,
  LicenceLevelSchema,
  MoneySchema,
  NonEmptyStringSchema,
  PaymentIdSchema,
  ReceiptIdSchema,
} from "./common.js";
import { ApprovalSchema } from "./records.js";

export const ApprovalCreatedEventSchema = z
  .object({
    event: z.literal("approval.created"),
    data: z.object({ approval: ApprovalSchema }).strict(),
  })
  .strict();
export const ApprovalResolvedEventSchema = z
  .object({
    event: z.literal("approval.resolved"),
    data: z
      .object({
        approval_id: ApprovalIdSchema,
        status: z.enum(["approved", "rejected", "expired"]),
      })
      .strict(),
  })
  .strict();
export const PaymentCompletedEventSchema = z
  .object({
    event: z.literal("payment.completed"),
    data: z
      .object({
        payment_id: PaymentIdSchema,
        outcome: z.literal("APPROVED"),
        amount: MoneySchema,
        merchant: NonEmptyStringSchema,
        receipt_id: ReceiptIdSchema,
      })
      .strict(),
  })
  .strict();
export const PaymentDeniedEventSchema = z
  .object({
    event: z.literal("payment.denied"),
    data: z
      .object({
        payment_id: PaymentIdSchema,
        user_explanation: NonEmptyStringSchema,
      })
      .strict(),
  })
  .strict();
export const AgentLicenceChangedEventSchema = z
  .object({
    event: z.literal("agent.licence_changed"),
    data: z
      .object({
        agent_id: AgentIdSchema,
        from: LicenceLevelSchema,
        to: LicenceLevelSchema,
        reason: NonEmptyStringSchema,
      })
      .strict(),
  })
  .strict();
export const AgentFrozenEventSchema = z
  .object({
    event: z.literal("agent.frozen"),
    data: z
      .object({
        agent_id: AgentIdSchema,
        reason: z.enum(["user", "circuit_breaker"]),
      })
      .strict(),
  })
  .strict();
export const TreasurerFundedEventSchema = z
  .object({
    event: z.literal("treasurer.funded"),
    data: z
      .object({
        pot: z.enum(["reserved", "buffer"]),
        amount: MoneySchema,
        commitment_id: CommitmentIdSchema.optional(),
      })
      .strict(),
  })
  .strict();
export const MonitorAlertEventSchema = z
  .object({
    event: z.literal("monitor.alert"),
    data: z
      .object({ invariant: NonEmptyStringSchema, detail: NonEmptyStringSchema })
      .strict(),
  })
  .strict();
export const DrillResultEventSchema = z
  .object({
    event: z.literal("drill.result"),
    data: z
      .object({
        agent_id: AgentIdSchema,
        passed: z.boolean(),
        points: z.number().int().safe(),
      })
      .strict(),
  })
  .strict();

export const AppEventSchema = z.discriminatedUnion("event", [
  ApprovalCreatedEventSchema,
  ApprovalResolvedEventSchema,
  PaymentCompletedEventSchema,
  PaymentDeniedEventSchema,
  AgentLicenceChangedEventSchema,
  AgentFrozenEventSchema,
  TreasurerFundedEventSchema,
  MonitorAlertEventSchema,
  DrillResultEventSchema,
]);
export type AppEvent = z.infer<typeof AppEventSchema>;
