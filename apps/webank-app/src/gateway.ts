import type { Agent, Approval } from "./flow";

export type LivePayment = {
  payment_id: string;
  status: "paid" | "denied" | "awaiting_user";
  amount: { amount: number; currency: string };
  merchant: string;
  created_at: string;
};

export type LiveReceipt = {
  receipt_id: string;
  merchant_legal_name: string;
  amount: { amount: number; currency: string };
  outcome: "APPROVED" | "DENIED";
  issued_at: string;
  chain: { network: string; payment_tx?: string; audit_tx: string };
  webank_sig: string;
};

export type LivePaymentDetail = {
  payment_id: string;
  status: LivePayment["status"];
  decision: {
    outcome: "APPROVED" | "DENIED" | "STEP_UP";
    user_explanation?: string;
  };
  receipt?: LiveReceipt;
};

export type PairingConsent = {
  approval: Approval;
  pairing: PairingSummary;
  public_key: string;
};

export type ReplacementSummary = {
  agent_id: string;
  display_name: string;
  provider: string;
  prior_status: string;
  status_before_revoke?: string;
  prior_licence_level: string;
  points: number;
  demerit_count: number;
  latest_reason: string | null;
  root_agent_id: string;
  deleted_at: string | null;
};

export type PairingSummary = {
  user_code: string;
  client_name: string;
  provider: string;
  requested_scopes: string[];
  status: "pending" | "approved" | "rejected" | "expired";
  expires_at: string;
  request_number_expires_at: string | null;
};

export type GatewaySnapshot = {
  agents: Agent[];
  approvals: Approval[];
  payments: LivePayment[];
  pairings: PairingSummary[];
};

export type Money = { amount: number; currency: "CNY" };
export type LiveHome = {
  schema: "home.v1";
  simulated: true;
  main_account: { balance: Money };
  agent_wallet: {
    balance: Money;
    reserved: Money;
    available: Money;
    address: string;
    frozen: boolean;
  };
  block_number: number;
  observed_at: string;
  alerts: string[];
};
export type FundingChallenge = {
  funding_id: string;
  challenge_id: string;
  action_hash: string;
  expires_at: string;
  source_balance: Money;
  destination_balance: Money;
  destination_address: string;
  simulated: true;
};
export type FundingRecord = {
  schema: "funding.v1";
  funding_id: string;
  user_id: string;
  amount: Money;
  source: "main";
  destination: "agent_wallet";
  status:
    | "prepared"
    | "settling"
    | "completed"
    | "reconciliation_required"
    | "failed";
  chain: { network: string; tx_hash?: string; block_number?: number };
  created_at: string;
  completed_at?: string;
};
export type SweepRecord = {
  schema: "sweep.v1";
  sweep_id: string;
  user_id: string;
  amount: Money;
  status: "settling" | "completed" | "reconciliation_required";
  chain: { network: string; tx_hash?: string; block_number?: number };
  created_at: string;
  completed_at?: string;
};
export type ScanResult =
  | { kind: "pairing"; user_code: string }
  | {
      kind: "payment";
      confirmation_id: string;
      challenge_id: string;
      action_hash: string;
      merchant_id: string;
      merchant_legal_name: string;
      merchant_uscc: string;
      order_id: string;
      amount: Money;
      source_account: "main";
      expires_at: string;
      simulated: true;
    };
export type HumanPayment = {
  schema: "human_payment.v1";
  confirmation_id: string;
  order_id: string;
  merchant_id: string;
  amount: Money;
  source_account: "main";
  status:
    | "prepared"
    | "settling"
    | "completed"
    | "reconciliation_required"
    | "failed";
  chain: { network: string; tx_hash?: string; block_number?: number };
  created_at: string;
  completed_at?: string;
};

export class GatewayRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

export function gatewaySnapshotErrorMessage(
  error: unknown,
  localDemo: boolean,
  hadAuthenticatedSession: boolean,
): string | null {
  if (
    localDemo &&
    !hadAuthenticatedSession &&
    error instanceof GatewayRequestError &&
    error.status === 401
  )
    return null;
  return error instanceof Error ? error.message : "Gateway unavailable";
}

export function isLoopbackLocalDemo(
  url: string | null,
  flag: string | undefined,
): boolean {
  if (!url || flag !== "1") return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.pathname === "/" &&
      !parsed.search &&
      !parsed.hash &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

const configuredUrl = process.env.EXPO_PUBLIC_GATEWAY_URL;
export const gatewayUrl = configuredUrl
  ? configuredUrl.trim().replace(/\/$/, "")
  : null;
const configuredDemoFlag = process.env.EXPO_PUBLIC_LOCAL_DEMO;
export const localDemoConfigured = isLoopbackLocalDemo(
  gatewayUrl,
  configuredDemoFlag,
);

type FetchLike = typeof fetch;

export function createGatewayClient(
  baseUrl: string,
  fetcher: FetchLike = fetch,
  localDemo = false,
) {
  const origin = baseUrl.replace(/\/$/, "");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${origin}${path}`, {
        credentials: "include",
        ...init,
      });
    } catch {
      throw new Error(
        "Gateway is offline. Showing the last synchronized data.",
      );
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as {
        error?: ({ code?: string } & Record<string, unknown>) | string;
      } | null;
      const code =
        typeof payload?.error === "string"
          ? payload.error
          : (payload?.error?.code ?? null);
      const rule =
        typeof payload?.error === "object" &&
        typeof payload.error?.rule === "string"
          ? payload.error.rule
          : null;
      const reason =
        code === "demo_login_denied"
          ? "Demo login token was not accepted."
          : rule === "insufficient_main_funds"
            ? "The confirmed main-account balance is too low for this transfer."
            : rule === "insufficient_wallet_funds"
              ? "The Agent Wallet has too little unreserved money to return."
              : code === "reconciliation_required"
                ? "The transfer outcome is being reconciled. Do not submit it again."
                : code === "chain_unavailable"
                  ? "Chain balance is unavailable. Try again after it recovers."
                  : code === "action_changed"
                    ? "This transfer review expired or changed. Start a new review."
                    : code === "request_number_expired"
                      ? "That pairing request number expired. Ask the connector to show its refreshed number."
                      : response.status === 401
                        ? "App session expired. Sign in again."
                        : response.status === 403
                          ? "Request is unavailable or expired."
                          : `Gateway returned ${response.status}.`;
      throw new GatewayRequestError(
        reason,
        response.status,
        code,
        typeof payload?.error === "object" ? payload.error : null,
      );
    }
    return response.json() as Promise<T>;
  }

  function mutationKey(prefix: string) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function requireLocalDemo() {
    if (!localDemo || !isLoopbackLocalDemo(origin, "1"))
      throw new Error(
        "Simulated approvals require the explicit loopback local demo mode.",
      );
  }

  return {
    async demoLogin(token: string): Promise<void> {
      requireLocalDemo();
      if (!/^[A-Za-z0-9_-]{16,}$/.test(token))
        throw new Error(
          "Enter the private local app token from the file path printed by the launcher.",
        );
      const result = await request<{ simulated: boolean }>("/demo/login", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (result.simulated !== true)
        throw new Error("Gateway did not confirm local demo mode.");
    },
    async snapshot(): Promise<GatewaySnapshot> {
      const [agents, approvals, payments, pairings] = await Promise.all([
        request<{ items: Agent[] }>("/v1/app/agents"),
        request<{ items: Approval[] }>("/v1/app/approvals?status=pending"),
        request<{ items: LivePayment[] }>("/v1/app/payments"),
        request<{ items: PairingSummary[] }>("/v1/app/pairings"),
      ]);
      if (
        !Array.isArray(agents.items) ||
        !Array.isArray(approvals.items) ||
        !Array.isArray(payments.items) ||
        !Array.isArray(pairings.items)
      )
        throw new Error("Gateway response is missing items.");
      return {
        agents: agents.items,
        approvals: approvals.items.filter((item) => item.status === "pending"),
        payments: payments.items,
        pairings: pairings.items,
      };
    },
    async home(): Promise<LiveHome> {
      const home = await request<LiveHome>("/v1/app/home");
      const money = (value: Money | undefined) =>
        value?.currency === "CNY" &&
        Number.isSafeInteger(value.amount) &&
        value.amount >= 0;
      if (
        home.schema !== "home.v1" ||
        home.simulated !== true ||
        !money(home.main_account?.balance) ||
        !money(home.agent_wallet?.balance) ||
        !money(home.agent_wallet?.reserved) ||
        !money(home.agent_wallet?.available) ||
        home.agent_wallet.available.amount !==
          Math.max(
            0,
            home.agent_wallet.balance.amount -
              home.agent_wallet.reserved.amount,
          ) ||
        typeof home.agent_wallet?.address !== "string" ||
        typeof home.agent_wallet?.frozen !== "boolean" ||
        !Number.isSafeInteger(home.block_number) ||
        !Number.isFinite(Date.parse(home.observed_at)) ||
        Date.parse(home.observed_at) > Date.now() + 15_000
      )
        throw new Error(
          "Gateway returned an invalid chain balance. Transfers are unavailable.",
        );
      return home;
    },
    fundingHistory(): Promise<FundingRecord[]> {
      return request<{ items: FundingRecord[] }>(
        "/v1/app/agent-wallet/funding",
      ).then((response) => {
        if (!Array.isArray(response.items))
          throw new Error("Funding history is unavailable.");
        return response.items;
      });
    },
    funding(fundingId: string): Promise<FundingRecord> {
      return request(
        `/v1/app/agent-wallet/funding/${encodeURIComponent(fundingId)}`,
      );
    },
    sweepHistory(): Promise<SweepRecord[]> {
      return request<{ items: SweepRecord[] }>(
        "/v1/app/agent-wallet/sweep",
      ).then((response) => {
        if (!Array.isArray(response.items))
          throw new Error("Return history is unavailable.");
        return response.items;
      });
    },
    sweepDetail(sweepId: string): Promise<SweepRecord> {
      return request(
        `/v1/app/agent-wallet/sweep/${encodeURIComponent(sweepId)}`,
      );
    },
    async prepareFunding(amountFen: number): Promise<FundingChallenge> {
      requireLocalDemo();
      const challenge = await request<FundingChallenge>(
        "/v1/app/agent-wallet/funding/prepare",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: { amount: amountFen, currency: "CNY" },
          }),
        },
      );
      if (
        challenge.simulated !== true ||
        !/^fnd_[A-Za-z0-9_-]+$/.test(challenge.funding_id) ||
        !/^fch_[A-Za-z0-9_-]+$/.test(challenge.challenge_id) ||
        !/^sha256:[0-9a-fA-F]{64}$/.test(challenge.action_hash) ||
        !/^0x[0-9a-fA-F]{40}$/.test(challenge.destination_address) ||
        Date.parse(challenge.expires_at) <= Date.now()
      )
        throw new Error("Gateway returned an invalid transfer review.");
      return challenge;
    },
    submitSimulatedFunding(
      challenge: FundingChallenge,
      amountFen: number,
    ): Promise<FundingRecord> {
      requireLocalDemo();
      return request("/v1/app/agent-wallet/funding", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `funding-${challenge.funding_id}`,
        },
        body: JSON.stringify({
          funding_id: challenge.funding_id,
          challenge_id: challenge.challenge_id,
          amount: { amount: amountFen, currency: "CNY" },
          verification: {
            action_hash: challenge.action_hash,
            device_signature: "simulated-local-funding",
          },
        }),
      });
    },
    sweep(amountFen: number): Promise<SweepRecord> {
      return request("/v1/app/agent-wallet/sweep", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": mutationKey("sweep"),
        },
        body: JSON.stringify({
          amount: { amount: amountFen, currency: "CNY" },
        }),
      });
    },
    pairing(userCode: string): Promise<PairingConsent> {
      return request(`/v1/app/pairing/${encodeURIComponent(userCode)}`);
    },
    scanPayload(qrPayload: string): Promise<ScanResult> {
      return request("/v1/app/scan/decode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qr_payload: qrPayload }),
      });
    },
    humanPayment(confirmationId: string): Promise<HumanPayment> {
      return request(
        `/v1/app/scan/payments/${encodeURIComponent(confirmationId)}`,
      );
    },
    confirmSimulatedHumanPayment(
      review: Extract<ScanResult, { kind: "payment" }>,
    ): Promise<HumanPayment> {
      requireLocalDemo();
      if (Date.parse(review.expires_at) <= Date.now())
        throw new Error("This QR payment review expired. Scan it again.");
      return request(
        `/v1/app/scan/payments/${encodeURIComponent(review.confirmation_id)}/confirm`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `human-payment-${review.confirmation_id}`,
          },
          body: JSON.stringify({
            challenge_id: review.challenge_id,
            verification: {
              action_hash: review.action_hash,
              device_signature: "simulated-local-human-payment",
            },
          }),
        },
      );
    },
    prepareAgentAction(agentId: string, action: "unfreeze" | "relicense") {
      return request<{
        action_hash: string;
        challenge_id: string;
        expires_at: string;
        agent_summary: ReplacementSummary;
      }>(`/v1/app/agents/${encodeURIComponent(agentId)}/prepare-action`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": mutationKey("prepare-action"),
        },
        body: JSON.stringify({ action }),
      });
    },
    agentHistory(agentId: string) {
      return request<{
        root_agent_id: string;
        items: Array<{ kind: string; summary: string; created_at: string }>;
      }>(`/v1/app/agents/${encodeURIComponent(agentId)}/history`);
    },
    completeSimulatedAgentAction(
      agentId: string,
      action: "unfreeze" | "relicense",
      challenge: { action_hash: string; challenge_id: string },
    ) {
      requireLocalDemo();
      return request<{ agent: Agent; simulated: true }>(
        `/v1/app/agents/${encodeURIComponent(agentId)}/${action}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": mutationKey(action),
          },
          body: JSON.stringify({
            challenge_id: challenge.challenge_id,
            verification: {
              action_hash: challenge.action_hash,
              device_signature: "simulated-local-approval",
            },
          }),
        },
      );
    },
    deleteAgent(agentId: string): Promise<{ agent: Agent }> {
      return request(`/v1/app/agents/${encodeURIComponent(agentId)}/revoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": mutationKey("delete-agent"),
        },
        body: JSON.stringify({ confirmation_agent_id: agentId }),
      });
    },
    denyPairing(userCode: string): Promise<{ approval: Approval }> {
      return request(`/v1/app/pairing/${encodeURIComponent(userCode)}/deny`, {
        method: "POST",
        headers: { "Idempotency-Key": mutationKey("pair-deny") },
      });
    },
    rejectApproval(approvalId: string): Promise<unknown> {
      return request(
        `/v1/app/approvals/${encodeURIComponent(approvalId)}/decide`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": mutationKey("reject"),
          },
          body: JSON.stringify({ decision: "reject" }),
        },
      );
    },
    freezeAgent(agentId: string): Promise<{ agent: Agent }> {
      return request(`/v1/app/agents/${encodeURIComponent(agentId)}/freeze`, {
        method: "POST",
        headers: { "Idempotency-Key": mutationKey("freeze") },
      });
    },
    payment(paymentId: string): Promise<LivePaymentDetail> {
      return request(`/v1/app/payments/${encodeURIComponent(paymentId)}`);
    },
    async approveSimulated(
      approval: Approval,
      requestNumber?: string,
      pairingCode?: string,
    ): Promise<unknown> {
      requireLocalDemo();
      if (
        approval.status !== "pending" ||
        Date.parse(approval.expires_at) <= Date.now()
      )
        throw new Error("This approval has expired. Start a new request.");
      if (!/^sha256:[0-9a-fA-F]{64}$/.test(approval.payload_hash))
        throw new Error("Approval action hash is invalid.");
      if (
        approval.level === "zero_trust" &&
        !/^\d{6}$/.test(requestNumber ?? "")
      )
        throw new Error("Enter the exact six-digit number from the connector.");
      if (approval.level !== "zero_trust" && requestNumber !== undefined)
        throw new Error("This approval does not use a request number.");
      if (approval.kind === "pairing" && !pairingCode)
        throw new Error("Pairing code is required for this approval.");
      if (approval.kind === "pairing" && pairingCode !== approval.subject_id)
        throw new Error("Pairing code does not match this consent card.");
      const path =
        approval.kind === "pairing"
          ? `/v1/app/pairing/${encodeURIComponent(pairingCode ?? "")}/approve`
          : `/v1/app/approvals/${encodeURIComponent(approval.approval_id)}/decide`;
      return request(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": mutationKey("simulated-approve"),
        },
        body: JSON.stringify({
          ...(approval.kind === "pairing" ? {} : { decision: "approve" }),
          verification: {
            action_hash: approval.payload_hash,
            device_signature: "simulated-local-approval",
            ...(requestNumber ? { request_number: requestNumber } : {}),
          },
        }),
      });
    },
  };
}

const liveClient = gatewayUrl
  ? createGatewayClient(gatewayUrl, fetch, localDemoConfigured)
  : null;

function configuredClient() {
  if (!liveClient) throw new Error("Gateway URL is not configured.");
  return liveClient;
}

export const loadGatewaySnapshot = () => configuredClient().snapshot();
export const loadGatewayHome = () => configuredClient().home();
export const loadGatewayFundingHistory = () =>
  configuredClient().fundingHistory();
export const loadGatewayFunding = (id: string) =>
  configuredClient().funding(id);
export const loadGatewaySweepHistory = () => configuredClient().sweepHistory();
export const loadGatewaySweep = (id: string) =>
  configuredClient().sweepDetail(id);
export const prepareGatewayFunding = (amountFen: number) =>
  configuredClient().prepareFunding(amountFen);
export const submitSimulatedGatewayFunding = (
  challenge: FundingChallenge,
  amountFen: number,
) => configuredClient().submitSimulatedFunding(challenge, amountFen);
export const sweepGatewayWallet = (amountFen: number) =>
  configuredClient().sweep(amountFen);
export const loadPairingConsent = (code: string) =>
  configuredClient().pairing(code);
export const scanGatewayQrPayload = (payload: string) =>
  configuredClient().scanPayload(payload);
export const loadHumanPayment = (id: string) =>
  configuredClient().humanPayment(id);
export const confirmSimulatedHumanPayment = (
  review: Extract<ScanResult, { kind: "payment" }>,
) => configuredClient().confirmSimulatedHumanPayment(review);
export const prepareGatewayAgentAction = (
  id: string,
  action: "unfreeze" | "relicense",
) => configuredClient().prepareAgentAction(id, action);
export const loadGatewayAgentHistory = (id: string) =>
  configuredClient().agentHistory(id);
export const completeSimulatedGatewayAgentAction = (
  id: string,
  action: "unfreeze" | "relicense",
  challenge: { action_hash: string; challenge_id: string },
) => configuredClient().completeSimulatedAgentAction(id, action, challenge);
export const deleteGatewayAgent = (id: string) =>
  configuredClient().deleteAgent(id);
export const denyGatewayPairing = (code: string) =>
  configuredClient().denyPairing(code);
export const rejectGatewayApproval = (id: string) =>
  configuredClient().rejectApproval(id);
export const freezeGatewayAgent = (id: string) =>
  configuredClient().freezeAgent(id);
export const loadGatewayPayment = (id: string) =>
  configuredClient().payment(id);
export const loginLocalDemo = (token: string) =>
  configuredClient().demoLogin(token);
export const approveLocalDemo = (
  approval: Approval,
  number?: string,
  code?: string,
) => configuredClient().approveSimulated(approval, number, code);
