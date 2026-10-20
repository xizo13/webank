import { type DenialRule, RuleDeniedErrorSchema } from "@webank/contracts";
import type { Check } from "./decision.js";

const rules: Record<
  DenialRule,
  { code: string; user_explanation: string; fixable: boolean }
> = {
  scope_missing: {
    code: "scope_missing",
    user_explanation:
      "This agent does not have permission for that wallet action.",
    fixable: false,
  },
  mandate_required: {
    code: "mandate_required",
    user_explanation:
      "Create and obtain approval for a mandate from your request before shopping or paying.",
    fixable: true,
  },
  mandate_not_found: {
    code: "mandate_not_found",
    user_explanation: "This mandate is unavailable to this agent.",
    fixable: true,
  },
  mandate_expired: {
    code: "mandate_expired",
    user_explanation:
      "This mandate expired. Ask for a new mandate from the user's request.",
    fixable: true,
  },
  execution_window_closed: {
    code: "mandate_expired",
    user_explanation: "The mandate's permitted time window has ended.",
    fixable: true,
  },
  mandate_exhausted: {
    code: "mandate_exhausted",
    user_explanation: "This mandate has no uses left.",
    fixable: true,
  },
  budget_exceeded: {
    code: "mandate_exhausted",
    user_explanation: "This purchase exceeds the mandate's remaining budget.",
    fixable: true,
  },
  occurrences_exceeded: {
    code: "mandate_exhausted",
    user_explanation: "This mandate has reached its permitted purchase count.",
    fixable: true,
  },
  mandate_cancelled: {
    code: "mandate_cancelled",
    user_explanation: "The user cancelled this mandate.",
    fixable: true,
  },
  agent_key_mismatch: {
    code: "mandate_mismatch",
    user_explanation: "This mandate belongs to a different agent key.",
    fixable: false,
  },
  category_mismatch: {
    code: "mandate_mismatch",
    user_explanation: "The merchant category is outside the mandate.",
    fixable: true,
  },
  merchant_mismatch: {
    code: "mandate_mismatch",
    user_explanation: "The merchant differs from the mandate.",
    fixable: true,
  },
  product_mismatch: {
    code: "mandate_mismatch",
    user_explanation: "The signed product differs from the mandate.",
    fixable: true,
  },
  variant_mismatch: {
    code: "mandate_mismatch",
    user_explanation: "The signed colour or size differs from the mandate.",
    fixable: true,
  },
  variant_sku_mismatch: {
    code: "mandate_mismatch",
    user_explanation: "The signed variant and product identity disagree.",
    fixable: true,
  },
  sku_mismatch: {
    code: "mandate_mismatch",
    user_explanation: "The signed listing SKU differs from the mandate.",
    fixable: true,
  },
  quantity_mismatch: {
    code: "mandate_mismatch",
    user_explanation: "The signed quantity differs from the mandate.",
    fixable: true,
  },
  merchant_unknown: {
    code: "merchant_unknown",
    user_explanation:
      "This merchant is not registered for Agent Wallet payments.",
    fixable: true,
  },
  merchant_honeypot: {
    code: "merchant_unknown",
    user_explanation: "This merchant is blocked by WeBank's safety checks.",
    fixable: false,
  },
  category_blocked: {
    code: "policy_denied",
    user_explanation: "This category is blocked by your Agent Wallet policy.",
    fixable: false,
  },
  over_per_payment_cap: {
    code: "policy_denied",
    user_explanation: "This amount exceeds your per-payment limit.",
    fixable: false,
  },
  over_daily_cap: {
    code: "policy_denied",
    user_explanation: "This amount exceeds your daily limit.",
    fixable: false,
  },
  over_monthly_cap: {
    code: "policy_denied",
    user_explanation: "This amount exceeds your monthly limit.",
    fixable: false,
  },
  over_licence_cap: {
    code: "policy_denied",
    user_explanation: "This amount exceeds the agent's licence limit.",
    fixable: false,
  },
  licence_suspended: {
    code: "policy_denied",
    user_explanation: "This agent's licence is suspended.",
    fixable: false,
  },
  insufficient_reserved_funds: {
    code: "policy_denied",
    user_explanation: "The agent wallet cannot reserve this mandate budget.",
    fixable: false,
  },
  insufficient_wallet_funds: {
    code: "policy_denied",
    user_explanation: "The agent wallet does not hold enough confirmed funds.",
    fixable: false,
  },
  insufficient_main_funds: {
    code: "policy_denied",
    user_explanation:
      "The simulated main account does not have enough confirmed funds.",
    fixable: false,
  },
  duplicate_payment: {
    code: "risk_denied",
    user_explanation: "This order has already been submitted for payment.",
    fixable: false,
  },
  velocity_blocked: {
    code: "risk_denied",
    user_explanation: "Payment activity is blocked by WeBank's risk rules.",
    fixable: false,
  },
  intent_mismatch: {
    code: "guardian_denied",
    user_explanation:
      "The purchase does not match the user's confirmed request.",
    fixable: true,
  },
  guardian_other: {
    code: "guardian_denied",
    user_explanation:
      "WeBank's Guardian could not safely approve this purchase.",
    fixable: true,
  },
  user_rejected: {
    code: "approval_rejected",
    user_explanation: "You rejected this payment in WeBank.",
    fixable: false,
  },
};

export function denial(rule: DenialRule, detail: Record<string, unknown> = {}) {
  return RuleDeniedErrorSchema.parse({ ...rules[rule], rule, detail });
}

export function denialFromChecks(checks: Check[]) {
  const failed = checks.find((check) => check.result === "deny");
  const reason = failed?.detail?.reason;
  if (failed?.name === "rail_validation") {
    const mapped: Record<string, DenialRule> = {
      fire_drill_decoy: "merchant_honeypot",
      per_payment_cap_exceeded: "over_per_payment_cap",
      daily_cap_exceeded: "over_daily_cap",
      monthly_cap_exceeded: "over_monthly_cap",
      insufficient_wallet_funds: "insufficient_wallet_funds",
      duplicate_payment: "duplicate_payment",
      merchant_unknown: "merchant_unknown",
    };
    const rule = mapped[String(reason)];
    if (rule) return denial(rule);
  }
  if (failed?.name === "mandate") {
    const mapped: Record<string, DenialRule> = {
      mandate_expired: "mandate_expired",
      mandate_exhausted: "mandate_exhausted",
      mandate_cancelled: "mandate_cancelled",
      mandate_budget_exceeded: "budget_exceeded",
      category_outside_mandate: "category_mismatch",
      merchant_outside_mandate: "merchant_mismatch",
      quantity_mismatch: "quantity_mismatch",
      gtin_mismatch: "product_mismatch",
      condition_mismatch: "product_mismatch",
      variant_mismatch: "variant_mismatch",
      sku_mismatch: "sku_mismatch",
      product_model_mismatch: "product_mismatch",
      locked_product_missing: "product_mismatch",
      mandate_not_started: "execution_window_closed",
    };
    const rule = mapped[String(reason)];
    if (rule) return denial(rule);
  }
  if (failed?.name === "policy_licence") {
    const mapped: Record<string, DenialRule> = {
      blocked_category: "category_blocked",
      per_payment_cap_exceeded: "over_per_payment_cap",
      licence_cap_exceeded: "over_licence_cap",
      daily_cap_exceeded: "over_daily_cap",
      monthly_cap_exceeded: "over_monthly_cap",
      licence_suspended: "licence_suspended",
    };
    const rule = mapped[String(reason)];
    if (rule) return denial(rule);
  }
  if (failed?.name === "risk" && reason === "duplicate_order")
    return denial("duplicate_payment");
  if (failed?.name === "risk" && reason === "velocity_blocked")
    return denial("velocity_blocked");
  if (failed?.name === "guardian")
    return denial(
      reason === "intent_mismatch" ? "intent_mismatch" : "guardian_other",
    );
  throw new Error("Unmapped payment denial check");
}
