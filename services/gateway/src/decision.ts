import type {
  Agent,
  Decision,
  Mandate,
  PaymentRequest,
  Policy,
} from "@webank/contracts";
import type { Merchant } from "./types.js";

export type Check = Decision["checks"][number];
export type Result = "pass" | "step_up" | "deny";

export function strictest(results: Result[]): Result {
  if (results.includes("deny")) return "deny";
  if (results.includes("step_up")) return "step_up";
  return "pass";
}

export function mandateIntentLevel(
  constraints: Mandate["constraints"],
): Mandate["intent_level"] {
  const merchant = constraints.find(
    (item) => item.type === "allowed_merchants",
  );
  const product = constraints.find((item) => item.type === "product");
  if (merchant?.merchant_ids && product?.skus) return "listing";
  if (product?.gtin || (product?.brand && product.model)) return "product";
  return "open";
}

export function budgetOf(mandate: Mandate): number | null {
  const budget = mandate.constraints.find((item) => item.type === "budget");
  return budget?.max.amount ?? null;
}

export function checkMandate(
  mandate: Mandate,
  request: PaymentRequest,
  merchant: Merchant,
  now: Date,
  allowPendingCheckout = false,
): Check {
  const deny = (reason: string): Check => ({
    name: "mandate",
    result: "deny",
    detail: { reason },
  });
  if (
    mandate.status !== "active" &&
    !(allowPendingCheckout && mandate.status === "pending_checkout")
  )
    return deny(`mandate_${mandate.status}`);
  const window = mandate.constraints.find(
    (item) => item.type === "execution_window",
  );
  if (!window || Date.parse(window.not_after) <= now.getTime())
    return deny("mandate_expired");
  if (window.not_before && Date.parse(window.not_before) > now.getTime())
    return deny("mandate_not_started");
  const budget = mandate.constraints.find((item) => item.type === "budget");
  const amountRange = mandate.constraints.find(
    (item) => item.type === "amount_range",
  );
  const recurrence = mandate.constraints.find(
    (item) => item.type === "recurrence",
  );
  if (!budget || !amountRange || !recurrence)
    return deny("mandate_missing_required_limits");
  if (
    [budget.max, amountRange.max, mandate.spent].some(
      (money) => money.currency !== request.amount.currency,
    )
  )
    return deny("currency_mismatch");
  if (
    request.amount.amount > amountRange.max.amount ||
    request.amount.amount > budget.max.amount - mandate.spent.amount
  )
    return deny("mandate_budget_exceeded");
  if (mandate.occurrences >= recurrence.max_occurrences)
    return deny("mandate_exhausted");
  const category = mandate.constraints.find(
    (item) => item.type === "categories",
  );
  if (category && !category.allowed.includes(merchant.category))
    return deny("category_outside_mandate");
  const merchants = mandate.constraints.find(
    (item) => item.type === "allowed_merchants",
  );
  if (
    merchants?.merchant_ids &&
    !merchants.merchant_ids.includes(request.merchant_id)
  )
    return deny("merchant_outside_mandate");
  const product = mandate.constraints.find((item) => item.type === "product");
  if (mandate.intent_level !== "open" && !product)
    return deny("locked_product_missing");
  const productItems = request.line_items.filter(
    (item) => item.type === "product",
  );
  if (product) {
    const totalQty = productItems.reduce((sum, item) => sum + item.qty, 0);
    if (totalQty !== product.qty) return deny("quantity_mismatch");
    if (product.gtin && productItems.some((item) => item.gtin !== product.gtin))
      return deny("gtin_mismatch");
    if (
      product.condition &&
      productItems.some((item) => item.condition !== product.condition)
    )
      return deny("condition_mismatch");
    if (product.variant) {
      const expected = product.variant.trim().toLowerCase();
      if (
        productItems.some(
          (item) => item.variant.trim().toLowerCase() !== expected,
        )
      )
        return deny("variant_mismatch");
    }
    if (
      product.skus &&
      productItems.some((item) => !product.skus?.includes(item.sku))
    )
      return deny("sku_mismatch");
  }
  return { name: "mandate", result: "pass" };
}

export function checkPolicy(
  agent: Agent,
  policy: Policy,
  request: PaymentRequest,
  merchant: Merchant,
  spentToday: number,
  spentMonth: number,
): Check {
  const deny = (reason: string): Check => ({
    name: "policy_licence",
    result: "deny",
    detail: { reason },
  });
  const amount = request.amount.amount;
  const currency = request.amount.currency;
  if (
    [policy.per_payment_max, policy.daily_max, policy.monthly_max].some(
      (limit) => limit.currency !== currency,
    )
  )
    return deny("currency_mismatch");
  if (policy.blocked_categories.includes(merchant.category))
    return deny("blocked_category");
  if (agent.licence.level === "RED") return deny("licence_suspended");
  const effectiveCap = policy.per_payment_max.amount;
  if (amount > effectiveCap) return deny("per_payment_cap_exceeded");
  if (spentToday + amount > policy.daily_max.amount)
    return deny("daily_cap_exceeded");
  if (spentMonth + amount > policy.monthly_max.amount)
    return deny("monthly_cap_exceeded");
  const autoCap =
    agent.licence.level === "GREEN" ? policy.auto_approve_below.amount : 0;
  const requiresTap =
    autoCap === 0 ||
    amount > autoCap ||
    (policy.new_merchant_requires_tap && merchant.first_seen);
  return {
    name: "policy_licence",
    result: requiresTap ? "step_up" : "pass",
    detail: {
      effective_cap: effectiveCap,
      auto_approve_cap: autoCap,
      ...(agent.licence.level === "AMBER"
        ? { reason: "amber_requires_tap" }
        : {}),
    },
  };
}
