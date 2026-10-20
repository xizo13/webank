import type {
  EditablePolicyLimits,
  Money,
  PolicySnapshot,
  PreparedPolicyChange,
} from "./gateway";

export type PolicyDraft = {
  per_payment_max: string;
  daily_max: string;
  monthly_max: string;
  auto_approve_below: string;
};

const fields = [
  "per_payment_max",
  "daily_max",
  "monthly_max",
  "auto_approve_below",
] as const;
const contractFields = ["per_payment_max", "daily_max", "monthly_max"] as const;

function validMoney(value: Money | undefined): boolean {
  return (
    value?.currency === "CNY" &&
    Number.isSafeInteger(value.amount) &&
    value.amount >= 0
  );
}

function sameLimits(a: EditablePolicyLimits, b: EditablePolicyLimits): boolean {
  return fields.every((field) => a[field].amount === b[field].amount);
}

export function policyLimits(
  policy: EditablePolicyLimits,
): EditablePolicyLimits {
  return {
    per_payment_max: policy.per_payment_max,
    daily_max: policy.daily_max,
    monthly_max: policy.monthly_max,
    auto_approve_below: policy.auto_approve_below,
  };
}

export function policyDraft(policy: EditablePolicyLimits): PolicyDraft {
  return {
    per_payment_max: (policy.per_payment_max.amount / 100).toFixed(2),
    daily_max: (policy.daily_max.amount / 100).toFixed(2),
    monthly_max: (policy.monthly_max.amount / 100).toFixed(2),
    auto_approve_below: (policy.auto_approve_below.amount / 100).toFixed(2),
  };
}

function parseFen(value: string): number | null {
  const trimmed = value.trim();
  if (!/^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.test(trimmed)) return null;
  const [yuan, cents = ""] = trimmed.split(".");
  const amount = Number(yuan) * 100 + Number(cents.padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? amount : null;
}

export function parsePolicyDraft(
  draft: PolicyDraft,
):
  | { proposed: EditablePolicyLimits; error: null }
  | { proposed: null; error: string } {
  const perPayment = parseFen(draft.per_payment_max);
  const daily = parseFen(draft.daily_max);
  const monthly = parseFen(draft.monthly_max);
  const green = parseFen(draft.auto_approve_below);
  if (
    perPayment === null ||
    daily === null ||
    monthly === null ||
    green === null
  )
    return {
      proposed: null,
      error: "Enter each amount in CNY with at most two decimal places.",
    };
  if (
    perPayment <= 0 ||
    perPayment > daily ||
    daily > monthly ||
    green > perPayment
  )
    return {
      proposed: null,
      error:
        "Use 0 < per payment <= daily <= monthly, and Green threshold <= per payment.",
    };
  const money = (amount: number): Money => ({ amount, currency: "CNY" });
  return {
    proposed: {
      per_payment_max: money(perPayment),
      daily_max: money(daily),
      monthly_max: money(monthly),
      auto_approve_below: money(green),
    },
    error: null,
  };
}

export function policyChangeIsLoosening(
  current: EditablePolicyLimits,
  proposed: EditablePolicyLimits,
): boolean {
  return fields.some((field) => proposed[field].amount > current[field].amount);
}

export function policyReviewStillCurrent(
  snapshot: PolicySnapshot | null,
  expectedHash: string,
  expectedBlock: string,
): boolean {
  return (
    snapshot?.sync_status === "consistent" &&
    snapshot.policy_hash === expectedHash &&
    snapshot.contract?.block_number === expectedBlock
  );
}

export function validatePolicySnapshot(snapshot: PolicySnapshot): void {
  const { policy, contract } = snapshot;
  if (
    policy?.schema !== "policy.v1" ||
    !/^sha256:[0-9a-fA-F]{64}$/.test(snapshot.policy_hash) ||
    !fields.every((field) => validMoney(policy[field])) ||
    !["consistent", "change_pending", "mismatch", "chain_unavailable"].includes(
      snapshot.sync_status,
    )
  )
    throw new Error("Gateway policy response is incomplete.");
  if (!contract) {
    if (snapshot.sync_status === "consistent")
      throw new Error("Contract caps are unavailable; policy is unverified.");
    return;
  }
  if (
    !contractFields.every((field) => validMoney(contract[field])) ||
    !validMoney(contract.spent_today) ||
    !validMoney(contract.spent_month) ||
    !/^\d+$/.test(contract.block_number) ||
    !Number.isFinite(Date.parse(contract.observed_at)) ||
    !Number.isFinite(Date.parse(contract.next_daily_reset_at)) ||
    !Number.isFinite(Date.parse(contract.next_monthly_reset_at))
  )
    throw new Error("Contract policy readback is incomplete.");
  if (
    snapshot.sync_status === "consistent" &&
    !contractFields.every(
      (field) => contract[field].amount === policy[field].amount,
    )
  )
    throw new Error("Gateway policy and contract caps disagree.");
}

export function validatePreparedPolicyChange(
  change: PreparedPolicyChange,
  snapshot: PolicySnapshot,
  proposed: EditablePolicyLimits,
): void {
  if (
    !change.change_id ||
    !/^sha256:[0-9a-fA-F]{64}$/.test(change.action_hash) ||
    !Number.isFinite(Date.parse(change.expires_at)) ||
    Date.parse(change.expires_at) <= Date.now() ||
    change.simulated !== true ||
    typeof change.requires_verification !== "boolean" ||
    !fields.every((field) => validMoney(change.current?.[field])) ||
    !fields.every((field) => validMoney(change.proposed?.[field])) ||
    !sameLimits(change.current, snapshot.policy) ||
    !sameLimits(change.proposed, proposed) ||
    (policyChangeIsLoosening(snapshot.policy, proposed) &&
      !change.requires_verification)
  )
    throw new Error("Policy change review does not match current limits.");
}
