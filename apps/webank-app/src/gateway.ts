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
  client_name: string;
  provider: string;
  requested_scopes: string[];
  public_key: string;
};

export type GatewaySnapshot = {
  agents: Agent[];
  approvals: Approval[];
  payments: LivePayment[];
};

export class GatewayRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
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
        error?: { code?: string } | string;
      } | null;
      const code =
        typeof payload?.error === "string"
          ? payload.error
          : (payload?.error?.code ?? null);
      const reason =
        code === "demo_login_denied"
          ? "Demo login token was not accepted."
          : response.status === 401
            ? "App session expired. Sign in again."
            : response.status === 403
              ? "Request is unavailable or expired."
              : `Gateway returned ${response.status}.`;
      throw new GatewayRequestError(reason, response.status, code);
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
          "Enter the one-time token printed by the local Gateway.",
        );
      const result = await request<{ simulated: boolean }>("/demo/login", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (result.simulated !== true)
        throw new Error("Gateway did not confirm local demo mode.");
    },
    async snapshot(): Promise<GatewaySnapshot> {
      const [agents, approvals, payments] = await Promise.all([
        request<{ items: Agent[] }>("/v1/app/agents"),
        request<{ items: Approval[] }>("/v1/app/approvals?status=pending"),
        request<{ items: LivePayment[] }>("/v1/app/payments"),
      ]);
      if (
        !Array.isArray(agents.items) ||
        !Array.isArray(approvals.items) ||
        !Array.isArray(payments.items)
      )
        throw new Error("Gateway response is missing items.");
      return {
        agents: agents.items,
        approvals: approvals.items.filter((item) => item.status === "pending"),
        payments: payments.items,
      };
    },
    pairing(userCode: string): Promise<PairingConsent> {
      return request(`/v1/app/pairing/${encodeURIComponent(userCode)}`);
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
export const loadPairingConsent = (code: string) =>
  configuredClient().pairing(code);
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
