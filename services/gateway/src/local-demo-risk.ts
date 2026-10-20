import { demoVariantBySku } from "@webank/contracts";
import type { GatewayDependencies, RiskAssessment } from "./types.js";

type Input = Parameters<GatewayDependencies["assessRisk"]>[0];

/** A narrow, deterministic risk fixture. It never accepts agent price claims as proof. */
export function assessLocalDemoRisk(input: Input): RiskAssessment {
  const stepUp = (reason: string): RiskAssessment => ({
    result: "step_up",
    signals: [{ type: "local_demo_uncertain", score: 1, action: "step_up" }],
    explanation: reason,
  });
  const { mandate, merchant, paymentRequest } = input;
  if (
    !input.historyKnown ||
    !Number.isSafeInteger(input.earlierPaidOrdersHour) ||
    !Number.isSafeInteger(input.earlierPaymentAttemptsHour)
  )
    return stepUp("Payment history is unavailable for risk review.");
  if (input.earlierPaidOrdersHour > 1 || input.earlierPaymentAttemptsHour > 2)
    return stepUp("Recent payment activity needs owner review.");
  if (merchant.first_seen || merchant.honeypot)
    return stepUp("The merchant is new or part of a drill.");
  if (mandate.intent_level !== "listing")
    return stepUp("The purchase intent is broader than an exact listing.");
  if (input.priceEvidence.length > 0)
    return stepUp("Agent-supplied price evidence needs owner review.");
  const product = mandate.constraints.find((item) => item.type === "product");
  const allowed = mandate.constraints.find(
    (item) => item.type === "allowed_merchants",
  );
  const amount = mandate.constraints.find(
    (item) => item.type === "amount_range",
  );
  const productItems = paymentRequest.line_items.filter(
    (item) => item.type === "product",
  );
  if (
    !product?.gtin ||
    !product.skus ||
    product.skus.length !== 1 ||
    !allowed?.merchant_ids ||
    allowed.merchant_ids.length !== 1 ||
    allowed.merchant_ids[0] !== merchant.merchant_id ||
    !amount ||
    amount.max.currency !== paymentRequest.amount.currency ||
    input.ownerAutoApproveBelow <= 0 ||
    paymentRequest.amount.amount > input.ownerAutoApproveBelow ||
    productItems.length !== 1
  )
    return stepUp("The signed order lacks an exact low-value listing lock.");
  const item = productItems[0];
  if (!item) return stepUp("The signed product item is missing.");
  const trusted = demoVariantBySku(item.sku);
  if (
    !trusted ||
    trusted.merchant_id !== merchant.merchant_id ||
    (product.brand !== null &&
      trusted.brand.toLowerCase() !== product.brand.toLowerCase()) ||
    (product.model !== null &&
      trusted.model.toLowerCase() !== product.model.toLowerCase()) ||
    (product.variant !== null &&
      trusted.variant.toLowerCase() !== product.variant.toLowerCase()) ||
    item.variant.toLowerCase() !== trusted.variant.toLowerCase() ||
    item.sku !== product.skus[0] ||
    item.gtin !== product.gtin ||
    item.gtin !== trusted.gtin ||
    item.qty !== product.qty ||
    item.unit_price.currency !== amount.max.currency ||
    item.unit_price.amount > amount.max.amount ||
    paymentRequest.amount.amount > amount.max.amount
  )
    return stepUp("The signed item or price needs owner review.");
  return {
    result: "pass",
    signals: [],
    explanation:
      "Exact low-value listing and durable recent activity passed local risk checks.",
  };
}
