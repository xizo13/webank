import type { Approval } from "./flow";
import { formatMoney } from "./flow";

type Money = { amount: number; currency: "CNY" };
type Constraint =
  | { type: "amount_range" | "budget"; max: Money }
  | { type: "categories"; allowed: string[] }
  | { type: "allowed_merchants"; merchant_ids: string[] | null }
  | {
      type: "product";
      brand: string | null;
      model: string | null;
      variant: string | null;
      condition: string | null;
      gtin: string | null;
      skus: string[] | null;
      qty: number;
    }
  | { type: "must_have"; attributes: string[] }
  | { type: "recurrence"; frequency: string; max_occurrences: number }
  | { type: "execution_window"; not_before: string | null; not_after: string };

type ProductLine = {
  type: "product";
  sku: string;
  gtin: string;
  name: string;
  condition: string;
  variant: string;
  options: { colour?: string; size?: string };
  qty: number;
  unit_price: Money;
};
type ShippingLine = {
  type: "shipping";
  name: string;
  qty: 1;
  unit_price: Money;
};

export type PaymentReview = {
  schema: "payment_review.v1";
  status: "pending";
  approval_id: string;
  payment_id: string;
  payload_hash: string;
  expires_at: string;
  mandate_snapshot: {
    canonical_hash: string;
    mandate: {
      mandate_id: string;
      agent_id: string;
      agent_key_binding: string;
      description: string;
      intent_level: "open" | "product" | "listing";
      user_text: string;
      user_text_source: "agent_reported" | "webank_screen";
      approval_timing: "payment";
      constraints: Constraint[];
    };
  };
  signed_order: {
    payment_request_hash: string;
    merchant_id: string;
    merchant_legal_name: string;
    merchant_uscc: string;
    order_id: string;
    line_items: Array<ProductLine | ShippingLine>;
    amount: Money;
    expires_at: string;
  };
  decision_checks: Array<{
    name: string;
    result: string;
    detail?: Record<string, unknown>;
    signals?: string[];
  }>;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const hash = (value: unknown): value is string =>
  string(value) && /^sha256:[0-9a-fA-F]{64}$/.test(value);
const timestamp = (value: unknown): value is string =>
  string(value) && Number.isFinite(Date.parse(value));
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(string);
const nullableString = (value: unknown): value is string | null =>
  value === null || string(value);
const money = (value: unknown): value is Money =>
  record(value) &&
  Number.isSafeInteger(value.amount) &&
  (value.amount as number) >= 0 &&
  value.currency === "CNY";
const positiveInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
const lineTotal = (items: Array<ProductLine | ShippingLine>): number =>
  items.reduce((total, item) => total + item.qty * item.unit_price.amount, 0);

function constraint(value: unknown): value is Constraint {
  if (!record(value)) return false;
  switch (value.type) {
    case "amount_range":
    case "budget":
      return money(value.max);
    case "categories":
      return strings(value.allowed);
    case "allowed_merchants":
      return value.merchant_ids === null || strings(value.merchant_ids);
    case "product":
      return (
        nullableString(value.brand) &&
        nullableString(value.model) &&
        nullableString(value.variant) &&
        nullableString(value.condition) &&
        nullableString(value.gtin) &&
        (value.skus === null || strings(value.skus)) &&
        positiveInteger(value.qty)
      );
    case "must_have":
      return strings(value.attributes);
    case "recurrence":
      return string(value.frequency) && positiveInteger(value.max_occurrences);
    case "execution_window":
      return (
        (value.not_before === null || timestamp(value.not_before)) &&
        timestamp(value.not_after)
      );
    default:
      return false;
  }
}

function lineItem(value: unknown): value is ProductLine | ShippingLine {
  if (!record(value) || !string(value.name) || !money(value.unit_price))
    return false;
  if (value.type === "shipping") return value.qty === 1;
  if (value.type !== "product") return false;
  return (
    string(value.sku) &&
    string(value.gtin) &&
    string(value.condition) &&
    string(value.variant) &&
    value.unit_price.amount > 0 &&
    positiveInteger(value.qty) &&
    record(value.options) &&
    (value.options.colour === undefined || string(value.options.colour)) &&
    (value.options.size === undefined || string(value.options.size))
  );
}

export function parsePaymentReview(value: unknown): PaymentReview {
  if (!record(value)) throw new Error("Payment review is unavailable.");
  const snapshot = value.mandate_snapshot;
  const order = value.signed_order;
  const mandate = record(snapshot) ? snapshot.mandate : null;
  if (
    value.schema !== "payment_review.v1" ||
    value.status !== "pending" ||
    !string(value.approval_id) ||
    !string(value.payment_id) ||
    !hash(value.payload_hash) ||
    !timestamp(value.expires_at) ||
    !record(snapshot) ||
    !hash(snapshot.canonical_hash) ||
    !record(mandate) ||
    !string(mandate.mandate_id) ||
    !string(mandate.agent_id) ||
    !string(mandate.agent_key_binding) ||
    !string(mandate.description) ||
    !["open", "product", "listing"].includes(String(mandate.intent_level)) ||
    !string(mandate.user_text) ||
    !["agent_reported", "webank_screen"].includes(
      String(mandate.user_text_source),
    ) ||
    mandate.approval_timing !== "payment" ||
    !Array.isArray(mandate.constraints) ||
    !mandate.constraints.every(constraint) ||
    !record(order) ||
    !hash(order.payment_request_hash) ||
    !string(order.merchant_id) ||
    !string(order.merchant_legal_name) ||
    !string(order.merchant_uscc) ||
    !string(order.order_id) ||
    !Array.isArray(order.line_items) ||
    order.line_items.length === 0 ||
    !order.line_items.every(lineItem) ||
    !order.line_items.some(
      (item: ProductLine | ShippingLine) => item.type === "product",
    ) ||
    order.line_items.filter(
      (item: ProductLine | ShippingLine) => item.type === "shipping",
    ).length !== 1 ||
    !money(order.amount) ||
    (order.amount as Money).amount <= 0 ||
    !Number.isSafeInteger(
      lineTotal(order.line_items as Array<ProductLine | ShippingLine>),
    ) ||
    lineTotal(order.line_items as Array<ProductLine | ShippingLine>) !==
      (order.amount as Money).amount ||
    !timestamp(order.expires_at) ||
    !Array.isArray(value.decision_checks) ||
    value.decision_checks.length === 0 ||
    !value.decision_checks.every(
      (check: unknown) =>
        record(check) && string(check.name) && string(check.result),
    )
  )
    throw new Error("Payment review is incomplete. Approval is unavailable.");
  return value as PaymentReview;
}

export function reviewMatchesApproval(
  review: PaymentReview | null,
  approval: Approval | null,
  now: number,
): boolean {
  if (
    !review ||
    !approval ||
    approval.kind !== "payment" ||
    approval.review_schema !== "payment_review.v1" ||
    approval.status !== "pending" ||
    review.status !== "pending" ||
    review.approval_id !== approval.approval_id ||
    review.payment_id !== approval.subject_id ||
    review.payload_hash !== approval.payload_hash ||
    review.expires_at !== approval.expires_at ||
    Date.parse(review.expires_at) <= now ||
    Date.parse(review.signed_order.expires_at) <= now
  )
    return false;
  const window = review.mandate_snapshot.mandate.constraints.find(
    (item) => item.type === "execution_window",
  );
  const budget = review.mandate_snapshot.mandate.constraints.find(
    (item) => item.type === "budget",
  );
  if (window?.type !== "execution_window" || budget?.type !== "budget")
    return false;
  return (
    (!window.not_before || Date.parse(window.not_before) <= now) &&
    Date.parse(window.not_after) > now &&
    review.signed_order.amount.amount <= budget.max.amount
  );
}

export function reviewConstraintRows(review: PaymentReview) {
  const rows: Array<{ label: string; value: string }> = [];
  for (const item of review.mandate_snapshot.mandate.constraints) {
    switch (item.type) {
      case "amount_range":
        rows.push({
          label: "Payment limit",
          value: formatMoney(item.max.amount),
        });
        break;
      case "budget":
        rows.push({ label: "Budget", value: formatMoney(item.max.amount) });
        break;
      case "categories":
        rows.push({ label: "Categories", value: item.allowed.join(", ") });
        break;
      case "allowed_merchants":
        rows.push({
          label: "Merchant lock",
          value: item.merchant_ids?.join(", ") ?? "No merchant locked",
        });
        break;
      case "product":
        rows.push({
          label: "Product lock",
          value:
            [item.brand, item.model, item.variant, item.condition]
              .filter(Boolean)
              .join(" · ") || "No product identity locked",
        });
        rows.push({ label: "Quantity", value: String(item.qty) });
        rows.push({ label: "Locked GTIN", value: item.gtin ?? "Not locked" });
        rows.push({
          label: "Locked SKUs",
          value: item.skus?.join(", ") ?? "Not locked",
        });
        break;
      case "must_have":
        rows.push({ label: "Must have", value: item.attributes.join(", ") });
        break;
      case "recurrence":
        rows.push({
          label: "Occurrences",
          value: `${item.max_occurrences} · ${item.frequency}`,
        });
        break;
      case "execution_window":
        if (item.not_before)
          rows.push({ label: "Starts", value: item.not_before });
        rows.push({ label: "Intent expires", value: item.not_after });
        break;
    }
  }
  return rows;
}
