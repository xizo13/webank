export type Agent = {
  agent_id: string;
  display_name: string;
  status: "active" | "frozen" | "revoked";
  licence: {
    level: "L" | "P" | "FULL" | "SUSPENDED";
    clean_purchases: number;
    drills_passed: number;
  };
};

export type Approval = {
  approval_id: string;
  kind:
    | "pairing"
    | "payment"
    | "mandate"
    | "policy_loosen"
    | "treasurer_schedule"
    | "emergency_topup"
    | "unfreeze";
  subject_id: string;
  title: string;
  lines: string[];
  payload_hash: string;
  level: "zero_trust" | "everyday" | "in_app";
  expires_at: string;
  status: "pending" | "approved" | "rejected" | "expired";
};

export type Payment = {
  payment_id: string;
  amount: number;
  merchant: string;
  merchantLegalName: string;
  item: string;
  status: "paid" | "denied" | "awaiting_user";
  reason: string;
  at: string;
  chainTx?: string;
  auditTx?: string;
};

export type DemoState = {
  enabled: boolean;
  mainBalance: number;
  walletBalance: number;
  perPaymentMax: number;
  dailyMax: number;
  autoApproveBelow: number;
  agents: Agent[];
  approvals: Approval[];
  payments: Payment[];
  matchedApprovals: string[];
  numberFailures: Record<string, number>;
  frozenAll: boolean;
};

export const PAIRING_CODE = "WQ7K-3MXP";
// Demo connector fixtures only. These values must never appear on an app-facing approval card.
export const DEMO_CONNECTOR_NUMBERS: Record<string, string> = {
  apr_pair_claude: "481926",
  apr_pay_first: "739204",
};

export const initialDemoState = (): DemoState => ({
  enabled: false,
  mainBalance: 866000,
  walletBalance: 0,
  perPaymentMax: 30000,
  dailyMax: 50000,
  autoApproveBelow: 10000,
  agents: [],
  approvals: [],
  payments: [],
  matchedApprovals: [],
  numberFailures: {},
  frozenAll: false,
});

function approvalExpiry(now: number, ttlMs = 180_000) {
  return new Date(now + ttlMs).toISOString();
}

export function enableWallet(state: DemoState): DemoState {
  return { ...state, enabled: true };
}

export function fundWallet(state: DemoState, amount: number): DemoState {
  if (!state.enabled || amount <= 0 || amount > state.mainBalance) return state;
  return {
    ...state,
    mainBalance: state.mainBalance - amount,
    walletBalance: state.walletBalance + amount,
  };
}

export function queuePairing(state: DemoState, now = Date.now()): DemoState {
  if (
    !state.enabled ||
    state.frozenAll ||
    state.approvals.some(
      (a) => a.approval_id === "apr_pair_claude" && a.status === "pending",
    )
  )
    return state;
  if (
    state.agents.some(
      (agent) => agent.agent_id === "agt_claude" && agent.status !== "revoked",
    )
  )
    return state;
  const approval: Approval = {
    approval_id: "apr_pair_claude",
    kind: "pairing",
    subject_id: "agt_claude",
    title: "Claude wants to connect",
    lines: [
      "Anthropic - MacBook Pro, Shenzhen",
      "Can request payments and see its own history",
      "Cannot view your main account or change limits",
      "Starts on an L-plate licence",
    ],
    payload_hash: "sha256:demo-pair-claude",
    level: "zero_trust",
    expires_at: approvalExpiry(now, 600_000),
    status: "pending",
  };
  return {
    ...state,
    approvals: [
      ...state.approvals.filter(
        (item) => item.approval_id !== approval.approval_id,
      ),
      approval,
    ],
    matchedApprovals: state.matchedApprovals.filter(
      (id) => id !== approval.approval_id,
    ),
    numberFailures: { ...state.numberFailures, [approval.approval_id]: 0 },
  };
}

export function queueFirstPayment(
  state: DemoState,
  now = Date.now(),
): DemoState {
  const agent = state.agents.find((item) => item.agent_id === "agt_claude");
  const spentToday = state.payments
    .filter(
      (payment) =>
        payment.status === "paid" &&
        new Date(payment.at).toDateString() === new Date(now).toDateString(),
    )
    .reduce((sum, payment) => sum + payment.amount, 0);
  if (
    !state.enabled ||
    state.frozenAll ||
    agent?.status !== "active" ||
    state.walletBalance < 27900 ||
    state.perPaymentMax < 27900 ||
    spentToday + 27900 > state.dailyMax
  )
    return state;
  if (
    state.approvals.some(
      (a) => a.approval_id === "apr_pay_first" && a.status === "pending",
    )
  )
    return state;
  if (state.payments.some((payment) => payment.payment_id === "pay_first"))
    return state;
  const approval: Approval = {
    approval_id: "apr_pay_first",
    kind: "payment",
    subject_id: "pay_first",
    title: "Claude wants to pay ¥279.00",
    lines: [
      "To: Shop A Electronics Co., Ltd. (mock verified merchant)",
      "For: Sony WH-1000XM5 Black",
      "Why asking: first payment on L-plates",
      "Mandate: headphones, maximum ¥300.00",
    ],
    payload_hash: "sha256:demo-pay-first",
    level: "zero_trust",
    expires_at: approvalExpiry(now),
    status: "pending",
  };
  return {
    ...state,
    approvals: [
      ...state.approvals.filter(
        (item) => item.approval_id !== approval.approval_id,
      ),
      approval,
    ],
    matchedApprovals: state.matchedApprovals.filter(
      (id) => id !== approval.approval_id,
    ),
    numberFailures: { ...state.numberFailures, [approval.approval_id]: 0 },
  };
}

export type NumberResult =
  | "matched"
  | "wrong"
  | "cancelled"
  | "expired"
  | "not_required";

export function matchRequestNumber(
  state: DemoState,
  approvalId: string,
  entered: string,
  now = Date.now(),
): { state: DemoState; result: NumberResult } {
  const approval = state.approvals.find(
    (item) => item.approval_id === approvalId,
  );
  if (
    approval?.status !== "pending" ||
    Date.parse(approval.expires_at) <= now
  ) {
    return { state: expireApproval(state, approvalId), result: "expired" };
  }
  if (approval.level !== "zero_trust") return { state, result: "not_required" };
  if (
    !/^\d{6}$/.test(entered) ||
    entered !== DEMO_CONNECTOR_NUMBERS[approvalId]
  ) {
    const failures = (state.numberFailures[approvalId] ?? 0) + 1;
    const next = {
      ...state,
      numberFailures: { ...state.numberFailures, [approvalId]: failures },
    };
    return failures >= 3
      ? { state: rejectApproval(next, approvalId), result: "cancelled" }
      : { state: next, result: "wrong" };
  }
  return {
    state: {
      ...state,
      matchedApprovals: [...new Set([...state.matchedApprovals, approvalId])],
    },
    result: "matched",
  };
}

export function expireApproval(
  state: DemoState,
  approvalId: string,
): DemoState {
  return {
    ...state,
    approvals: state.approvals.map((approval) =>
      approval.approval_id === approvalId && approval.status === "pending"
        ? { ...approval, status: "expired" }
        : approval,
    ),
  };
}

export function rejectApproval(
  state: DemoState,
  approvalId: string,
): DemoState {
  return {
    ...state,
    approvals: state.approvals.map((approval) =>
      approval.approval_id === approvalId && approval.status === "pending"
        ? { ...approval, status: "rejected" }
        : approval,
    ),
  };
}

export function applyDemoBiometricApproval(
  state: DemoState,
  approvalId: string,
  freshBiometricSucceeded: boolean,
  now = Date.now(),
): DemoState {
  const approval = state.approvals.find(
    (item) => item.approval_id === approvalId,
  );
  if (
    !freshBiometricSucceeded ||
    !approval ||
    approval.status !== "pending" ||
    Date.parse(approval.expires_at) <= now ||
    (approval.level === "zero_trust" &&
      !state.matchedApprovals.includes(approvalId))
  )
    return state;

  const approvals = state.approvals.map((item) =>
    item.approval_id === approvalId
      ? { ...item, status: "approved" as const }
      : item,
  );
  if (approval.kind === "pairing") {
    return {
      ...state,
      approvals,
      agents: [
        ...state.agents,
        {
          agent_id: "agt_claude",
          display_name: "Claude (Anthropic)",
          status: "active",
          licence: { level: "L", clean_purchases: 0, drills_passed: 0 },
        },
      ],
    };
  }
  if (
    approval.kind === "payment" &&
    state.walletBalance >= 27900 &&
    !state.frozenAll
  ) {
    return {
      ...state,
      approvals,
      walletBalance: state.walletBalance - 27900,
      payments: [
        {
          payment_id: "pay_first",
          amount: 27900,
          merchant: "Shop A Electronics",
          merchantLegalName: "Shop A Electronics Co., Ltd. (mock)",
          item: "Sony WH-1000XM5 Black",
          status: "paid",
          reason: "You matched the request and confirmed this first payment.",
          at: new Date(now).toISOString(),
        },
        ...state.payments,
      ],
      agents: state.agents.map((agent) =>
        agent.agent_id === "agt_claude"
          ? {
              ...agent,
              licence: {
                ...agent.licence,
                clean_purchases: agent.licence.clean_purchases + 1,
              },
            }
          : agent,
      ),
    };
  }
  return state;
}

export function freezeAgent(state: DemoState, agentId: string): DemoState {
  return {
    ...state,
    agents: state.agents.map((agent) =>
      agent.agent_id === agentId ? { ...agent, status: "frozen" } : agent,
    ),
    approvals: state.approvals.map((approval) =>
      approval.kind === "payment" && approval.status === "pending"
        ? { ...approval, status: "rejected" }
        : approval,
    ),
  };
}

export function freezeAll(state: DemoState): DemoState {
  return {
    ...state,
    frozenAll: true,
    agents: state.agents.map((agent) => ({ ...agent, status: "frozen" })),
    approvals: state.approvals.map((approval) =>
      approval.status === "pending"
        ? { ...approval, status: "rejected" }
        : approval,
    ),
  };
}

export function simulateBlockedAttack(
  state: DemoState,
  now = Date.now(),
): DemoState {
  if (!state.agents.some((agent) => agent.status === "active")) return state;
  return {
    ...state,
    payments: [
      {
        payment_id: `pay_blocked_${now}`,
        amount: 27900,
        merchant: "Unknown payment link",
        merchantLegalName: "Unregistered merchant (simulation)",
        item: "Service fee inserted in a product listing",
        status: "denied",
        reason: "The payee does not match the verified shop in the mandate.",
        at: new Date(now).toISOString(),
      },
      ...state.payments,
    ],
  };
}

export function formatMoney(fen: number): string {
  return `¥${(fen / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}
