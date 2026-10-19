import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  AwaitingUserPaymentResponseSchema,
  CreateMandateRequestSchema,
  CreateMandateResponseSchema,
  CreatePaymentRequestSchema,
  DeniedPaymentResponseSchema,
  DeviceAuthorizationResponseSchema,
  DeviceTokenErrorSchema,
  MandateResponseSchema,
  PaidPaymentResponseSchema,
  PaymentHistoryResponseSchema,
  PaymentStatusResponseSchema,
  PendingMandatePaymentResponseSchema,
  RuleDeniedErrorSchema,
  TokenResponseSchema,
} from "@webank/contracts";
import { newAgentKey, signAgentRequest } from "./signing.js";
import type { CredentialStore, Credentials } from "./storage.js";

const execFileAsync = promisify(execFile);
const scopes = ["wallet:pay", "wallet:mandate", "wallet:history:self"] as const;
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";

export type Notification = (title: string, body: string) => Promise<void>;
export const macNotification: Notification = async (title, body) => {
  if (process.platform !== "darwin") {
    throw new Error("macOS notifications are unavailable on this device");
  }
  await execFileAsync("osascript", [
    "-e",
    "on run argv",
    "-e",
    "display notification (item 2 of argv) with title (item 1 of argv)",
    "-e",
    "end run",
    title,
    body,
  ]);
};

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly denial?: ReturnType<typeof RuleDeniedErrorSchema.parse>,
  ) {
    super(message);
  }
}

export class WeBankConnector {
  constructor(
    private readonly baseUrl: URL,
    private readonly store: CredentialStore,
    private readonly request: typeof fetch = fetch,
    private readonly notify: Notification = macNotification,
    private readonly now: () => number = Date.now,
  ) {
    if (!/^https?:$/.test(baseUrl.protocol)) {
      throw new Error("Gateway URL must use HTTP or HTTPS");
    }
    if (
      baseUrl.protocol !== "https:" &&
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(baseUrl.hostname)
    ) {
      throw new Error("Non-local Gateway URL must use HTTPS");
    }
  }

  private async json(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
    auth?: Credentials,
    keyOnly = false,
  ): Promise<{ status: number; data: unknown }> {
    const url = new URL(path, this.baseUrl);
    const serialized = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { accept: "application/json" };
    if (method === "POST") headers["content-type"] = "application/json";
    if (auth) {
      if (!auth.agentId || (!keyOnly && !auth.accessToken)) {
        throw new ConnectorError("Connect WeBank first", "not_connected");
      }
      const signed = signAgentRequest({
        method,
        path: url.pathname,
        body: serialized,
        idempotencyKey: randomUUID(),
        agentId: auth.agentId,
        privateKeyPem: auth.privateKeyPem,
        now: this.now(),
      });
      Object.assign(headers, signed);
      if (auth.accessToken)
        headers.authorization = `Bearer ${auth.accessToken}`;
    }
    const response = await this.request(url, {
      method,
      headers,
      ...(method === "POST" ? { body: serialized } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(path.includes("?wait=") ? 60_000 : 15_000),
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ConnectorError(
        `Gateway returned invalid JSON (${response.status})`,
      );
    }
    return { status: response.status, data };
  }

  private gatewayError(result: { status: number; data: unknown }): never {
    const value = result.data as { error?: unknown } | null;
    const error = value?.error;
    const code =
      typeof error === "string"
        ? error
        : error && typeof error === "object" && "code" in error
          ? String((error as { code: unknown }).code)
          : "gateway_error";
    const denied = RuleDeniedErrorSchema.safeParse(error);
    throw new ConnectorError(
      denied.success
        ? denied.data.user_explanation
        : code === "agent_frozen"
          ? "This agent cannot spend. Check its WeBank app status. Only the user can Unfreeze or Re-license it in the app; a revoked agent needs a new user-approved pairing."
          : `WeBank request failed (${result.status}: ${code})`,
      code,
      denied.success ? denied.data : undefined,
    );
  }

  private async credentials(): Promise<Credentials> {
    const current = await this.store.load();
    if (!current?.agentId || !current.accessToken) {
      throw new ConnectorError("Connect WeBank first", "not_connected");
    }
    if (
      current.tokenExpiresAt &&
      current.tokenExpiresAt <= this.now() + 30_000
    ) {
      return this.refresh(current);
    }
    return current;
  }

  private async refresh(current: Credentials): Promise<Credentials> {
    if (!current.refreshToken) {
      throw new ConnectorError(
        "WeBank session expired; pair again",
        "token_expired",
      );
    }
    const result = await this.json("/v1/oauth/token", "POST", {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
    });
    if (result.status !== 200) this.gatewayError(result);
    const tokens = TokenResponseSchema.parse(result.data);
    if (tokens.agent_id !== current.agentId) {
      throw new ConnectorError("Gateway returned a different agent identity");
    }
    const next = {
      ...current,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiresAt: this.now() + tokens.expires_in * 1000,
    };
    await this.store.save(next);
    return next;
  }

  private async agentRequest(
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ) {
    let current = await this.credentials();
    let result = await this.json(path, method, body, current);
    const code = (result.data as { error?: { code?: string } } | null)?.error
      ?.code;
    if (result.status === 401 && code === "token_expired") {
      current = await this.refresh(current);
      result = await this.json(path, method, body, current);
    }
    return result;
  }

  async connect(
    input: {
      client_name?: string;
      provider?: string;
      wait_seconds?: number;
      re_pair?: boolean;
    } = {},
  ) {
    const clientName = input.client_name || "Claude";
    const provider = input.provider || "Anthropic";
    const waitSeconds = Math.min(Math.max(input.wait_seconds ?? 0, 0), 20);
    let current = await this.store.load();
    let quarantined = current?.quarantined;
    let verifiedSession:
      | {
          state: string;
          access_token_valid?: boolean;
          agent_id?: string;
          licence?: unknown;
          active_mandates?: string[];
        }
      | undefined;
    if (current?.agentId) {
      const status = await this.json(
        "/v1/agent/session",
        "GET",
        undefined,
        current,
        true,
      );
      if (status.status !== 200) {
        const code = (status.data as { error?: { code?: string } } | null)
          ?.error?.code;
        if (status.status !== 401 || code !== "bad_signature")
          this.gatewayError(status);
        if (!input.re_pair)
          return {
            status: "not_paired",
            message:
              "Gateway could not verify the stored key. It remains saved. Use explicit re-pairing with owner approval or Delete agent in the WeBank app.",
          };
        const { pending: _pending, quarantined: _older, ...oldKey } = current;
        quarantined = oldKey;
        current = null;
      } else verifiedSession = status.data as typeof verifiedSession;
    }
    if (current?.agentId) {
      const session = verifiedSession;
      if (!session)
        throw new ConnectorError("Gateway session was not verified");
      if (
        !input.re_pair &&
        session.state === "connected" &&
        (session.access_token_valid === false ||
          (current.tokenExpiresAt &&
            current.tokenExpiresAt <= this.now() + 30_000))
      ) {
        try {
          await this.refresh(current);
        } catch {
          return {
            status: "not_paired",
            message: "The Gateway session needs a new user-approved pairing.",
          };
        }
      }
      if (!input.re_pair)
        return {
          status: session.state,
          agent_id: session.agent_id,
          licence: session.licence,
          active_mandates: session.active_mandates,
        };
      if (session.state !== "revoked") {
        const revoked = await this.json(
          "/v1/agent/session/revoke",
          "POST",
          { re_pair: true },
          current,
          true,
        );
        if (revoked.status !== 200) this.gatewayError(revoked);
      }
      await this.store.clear?.();
      current = null;
    }
    if (input.re_pair && current?.pending) {
      quarantined = current.quarantined;
      current = null;
    }
    if (current?.pending && current.pending.expiresAt <= this.now()) {
      await this.store.save({ ...current, pending: undefined });
      return {
        status: "pairing_expired",
        message:
          "The pairing code expired. Call connect_webank again for a fresh code.",
      };
    }
    if (!current?.pending || current.pending.expiresAt <= this.now()) {
      current = {
        ...newAgentKey(),
        ...(quarantined ? { quarantined } : {}),
      };
      const result = await this.json("/v1/oauth/device_authorization", "POST", {
        client_name: clientName,
        provider,
        agent_public_key: current.publicKey,
        requested_scopes: [...scopes],
      });
      if (result.status !== 200 && result.status !== 201)
        this.gatewayError(result);
      const pairing = DeviceAuthorizationResponseSchema.parse(result.data);
      current.pending = {
        deviceCode: pairing.device_code,
        userCode: pairing.user_code,
        verificationUri: pairing.verification_uri,
        qrPayload: pairing.qr_payload,
        requestNumber: pairing.request_number,
        expiresAt: this.now() + pairing.expires_in * 1000,
        interval: pairing.interval,
      };
      await this.store.save(current);
    }
    const pending = current.pending;
    let notificationDelivered = true;
    try {
      await this.notify(
        "WeBank agent pairing",
        `Request number ${pending.requestNumber}`,
      );
    } catch {
      notificationDelivered = false;
    }
    const until = this.now() + waitSeconds * 1000;
    do {
      const result = await this.json("/v1/oauth/token", "POST", {
        grant_type: deviceGrant,
        device_code: pending.deviceCode,
      });
      if (result.status === 200) {
        const tokens = TokenResponseSchema.parse(result.data);
        const connected: Credentials = {
          ...current,
          agentId: tokens.agent_id,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          tokenExpiresAt: this.now() + tokens.expires_in * 1000,
          pending: undefined,
          quarantined: undefined,
        };
        await this.store.save(connected);
        return { status: "connected", agent_id: tokens.agent_id };
      }
      const pendingError = DeviceTokenErrorSchema.safeParse(result.data);
      if (!pendingError.success) this.gatewayError(result);
      if (pendingError.data.error !== "authorization_pending") {
        await this.store.save({ ...current, pending: undefined });
        if (pendingError.data.error === "expired_token")
          return {
            status: "pairing_expired",
            message:
              "The pairing code expired. Call connect_webank again for a fresh code.",
          };
        throw new ConnectorError(
          `Pairing ${pendingError.data.error}`,
          pendingError.data.error,
        );
      }
      if (this.now() + pending.interval * 1000 >= until) break;
      await new Promise((resolve) =>
        setTimeout(resolve, pending.interval * 1000),
      );
    } while (this.now() < until);
    return {
      status: "awaiting_user",
      user_code: pending.userCode,
      verification_uri: pending.verificationUri,
      qr_payload: pending.qrPayload,
      request_number: pending.requestNumber,
      notification_delivered: notificationDelivered,
      expires_at: new Date(pending.expiresAt).toISOString(),
    };
  }

  async getWalletStatus() {
    const current = await this.store.load();
    if (!current)
      return {
        state: "not_paired",
        message: "Connect WeBank before checkout.",
      };
    if (current.agentId) {
      const result = await this.json(
        "/v1/agent/session",
        "GET",
        undefined,
        current,
        true,
      );
      if (result.status !== 200) {
        const code = (result.data as { error?: { code?: string } } | null)
          ?.error?.code;
        if (result.status === 401 && code === "bad_signature")
          return {
            state: "not_paired",
            message:
              "Gateway could not verify the stored key. It remains saved. Use explicit re-pairing with owner approval or Delete agent in the WeBank app.",
          };
        this.gatewayError(result);
      }
      if (
        (result.data as { state?: string }).state === "connected" &&
        ((result.data as { access_token_valid?: boolean })
          .access_token_valid === false ||
          (current.tokenExpiresAt &&
            current.tokenExpiresAt <= this.now() + 30_000))
      ) {
        try {
          await this.refresh(current);
        } catch {
          return {
            state: "not_paired",
            message: "The Gateway session needs a new user-approved pairing.",
          };
        }
      }
      return result.data;
    }
    if (!current.pending)
      return {
        state: "not_paired",
        message: "Connect WeBank before checkout.",
      };
    if (current.pending.expiresAt <= this.now()) {
      await this.store.save({ ...current, pending: undefined });
      return {
        state: "pairing_expired",
        message: "The pairing code expired. Start a new pairing.",
      };
    }
    const result = await this.pairingWait(current, 0);
    if (result.status === "approved") {
      const connected = await this.connect();
      return {
        state: connected.status,
        agent_id: "agent_id" in connected ? connected.agent_id : undefined,
      };
    }
    if (result.status === "expired") {
      await this.store.save({ ...current, pending: undefined });
      return {
        state: "pairing_expired",
        message: "The pairing code expired. Start a new pairing.",
      };
    }
    if (result.status === "rejected") {
      await this.store.save({ ...current, pending: undefined });
      return {
        state: "not_paired",
        message:
          "The user rejected this pairing. Start a new pairing only if requested.",
      };
    }
    return {
      state: "pairing_pending",
      user_code: current.pending.userCode,
      expires_at: result.expires_at,
      request_number_expires_at: result.request_number_expires_at,
    };
  }

  private async pairingWait(
    current: Credentials,
    waitSeconds: number,
  ): Promise<{
    status: string;
    expires_at: string;
    request_number?: string;
    request_number_expires_at?: string;
  }> {
    const pending = current.pending;
    if (!pending)
      throw new ConnectorError("No pairing is pending", "not_connected");
    const url = new URL(
      `/v1/oauth/device_authorization/${encodeURIComponent(pending.deviceCode)}?wait=${waitSeconds}`,
      this.baseUrl,
    );
    const response = await this.request(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout((waitSeconds + 5) * 1000),
    });
    const data = (await response.json()) as {
      status: string;
      expires_at: string;
      request_number?: string;
      request_number_expires_at?: string;
    };
    if (!response.ok) this.gatewayError({ status: response.status, data });
    if (data.request_number && data.request_number !== pending.requestNumber) {
      pending.requestNumber = data.request_number;
      await this.store.save(current);
      await this.notify(
        "WeBank agent pairing",
        `Request number ${data.request_number}`,
      ).catch(() => undefined);
    }
    return data;
  }

  async waitForApproval(input: {
    approval_id?: string;
    pairing?: boolean;
    wait_seconds?: number;
  }) {
    const wait = Math.min(55, Math.max(0, input.wait_seconds ?? 55));
    if (input.pairing) {
      const current = await this.store.load();
      if (!current?.pending)
        throw new ConnectorError("No pairing is pending", "not_connected");
      const result = await this.pairingWait(current, wait);
      if (result.status === "approved") {
        const connected = await this.connect();
        return {
          status: "approved",
          state: connected.status,
          agent_id: "agent_id" in connected ? connected.agent_id : undefined,
        };
      }
      if (result.status === "expired" || result.status === "rejected")
        await this.store.save({ ...current, pending: undefined });
      return result;
    }
    if (!input.approval_id || !/^apr_[A-Za-z0-9_-]+$/.test(input.approval_id))
      throw new ConnectorError(
        "Valid approval_id or pairing is required",
        "invalid_request",
      );
    const result = await this.agentRequest(
      `/v1/agent/approvals/${encodeURIComponent(input.approval_id)}?wait=${wait}`,
      "GET",
    );
    if (result.status !== 200) this.gatewayError(result);
    return result.data;
  }

  async disconnect() {
    const current = await this.store.load();
    if (!current?.agentId) {
      if (current?.quarantined)
        return {
          state: "revocation_required",
          message:
            "The old key could not be revoked by this connector and remains saved. Use Delete agent in the WeBank app if its record still exists.",
        };
      await this.store.clear?.();
      return { state: "not_paired" };
    }
    const result = await this.json(
      "/v1/agent/session/revoke",
      "POST",
      { re_pair: false },
      current,
      true,
    );
    if (result.status !== 200) {
      const code = (result.data as { error?: { code?: string } } | null)?.error
        ?.code;
      if (result.status === 401 && code === "bad_signature")
        return {
          state: "revocation_required",
          message:
            "Gateway could not verify or revoke this key. It remains saved. Use Delete agent in the WeBank app if its record still exists.",
        };
      this.gatewayError(result);
    }
    if (this.store.clear) await this.store.clear();
    else await this.store.save(newAgentKey());
    return {
      state: "revoked",
      message:
        "This connector is disconnected. The owner can delete its retained record in the WeBank app.",
    };
  }

  async createMandate(input: unknown) {
    const body = CreateMandateRequestSchema.parse(input);
    const result = await this.agentRequest("/v1/agent/mandates", "POST", body);
    if (result.status !== 201 && result.status !== 202)
      this.gatewayError(result);
    const response = CreateMandateResponseSchema.parse(result.data);
    let notificationDelivered = true;
    if (response.request_number) {
      try {
        await this.notify(
          "WeBank first mandate approval",
          `Request number ${response.request_number}`,
        );
      } catch {
        notificationDelivered = false;
      }
    }
    return {
      status: response.mandate.status,
      mandate_id: response.mandate.mandate_id,
      ...(response.approval_id ? { approval_id: response.approval_id } : {}),
      ...(response.level ? { level: response.level } : {}),
      ...(response.expires_at ? { expires_at: response.expires_at } : {}),
      ...(response.request_number
        ? {
            request_number: response.request_number,
            notification_delivered: notificationDelivered,
          }
        : {}),
      message:
        response.mandate.status === "pending_user"
          ? "Awaiting approval in the WeBank app. Confirm the mandate is active before shopping."
          : "Mandate active. Shopping may begin within this scope.",
    };
  }

  async getMandateStatus(mandateId: string) {
    if (!/^mdt_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(mandateId))
      throw new ConnectorError("Invalid mandate ID");
    const result = await this.agentRequest(
      `/v1/agent/mandates/${encodeURIComponent(mandateId)}`,
      "GET",
    );
    if (result.status !== 200) this.gatewayError(result);
    const { mandate } = MandateResponseSchema.parse(result.data);
    return {
      mandate_id: mandate.mandate_id,
      status: mandate.status,
      message:
        mandate.status === "active"
          ? "Mandate active. Continue with request_payment using the original checkout URI."
          : mandate.status === "pending_user"
            ? "Awaiting approval in the WeBank app. Do not request payment yet."
            : `Mandate ${mandate.status}; do not request payment.`,
    };
  }

  async requestPayment(input: unknown) {
    const body = CreatePaymentRequestSchema.parse(input);
    const result = await this.agentRequest("/v1/agent/payments", "POST", body);
    if (
      result.status === 202 &&
      (result.data as { mandate_id?: unknown })?.mandate_id
    ) {
      const pending = PendingMandatePaymentResponseSchema.parse(result.data);
      return {
        mandate_id: pending.mandate_id,
        status: pending.status,
        approval_id: pending.approval_id,
        level: pending.level,
        expires_at: pending.expires_at,
        message:
          "The mandate is awaiting approval in WeBank. No payment was created. Wait until it is active.",
      };
    }
    if (result.status === 200) {
      const payment = PaidPaymentResponseSchema.parse(result.data);
      return {
        payment_id: payment.payment_id,
        status: payment.status,
        explanation: payment.decision.user_explanation,
        receipt: payment.receipt,
      };
    }
    if (result.status === 202) {
      const payment = AwaitingUserPaymentResponseSchema.parse(result.data);
      let notificationDelivered = true;
      if (payment.approval_level === "zero_trust") {
        try {
          await this.notify(
            "WeBank first payment approval",
            `Request number ${payment.request_number}`,
          );
        } catch {
          notificationDelivered = false;
        }
      }
      return {
        payment_id: payment.payment_id,
        status: payment.status,
        explanation: payment.decision.user_explanation,
        approval_id: payment.approval_id,
        level: payment.level,
        expires_at: payment.expires_at,
        poll_after: payment.poll_after,
        ...(payment.approval_level === "zero_trust"
          ? {
              request_number: payment.request_number,
              notification_delivered: notificationDelivered,
            }
          : {}),
      };
    }
    if (
      result.status === 403 &&
      (result.data as { status?: string })?.status === "denied"
    ) {
      const payment = DeniedPaymentResponseSchema.parse(result.data);
      return {
        payment_id: payment.payment_id,
        status: payment.status,
        explanation: payment.decision.user_explanation,
        receipt: payment.receipt,
        error: payment.error,
      };
    }
    this.gatewayError(result);
  }

  async getPaymentStatus(paymentId: string) {
    if (!/^pay_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(paymentId)) {
      throw new ConnectorError("Invalid payment ID");
    }
    const result = await this.agentRequest(
      `/v1/agent/payments/${encodeURIComponent(paymentId)}`,
      "GET",
    );
    if (result.status !== 200) this.gatewayError(result);
    const payment = PaymentStatusResponseSchema.parse(result.data);
    return {
      payment_id: payment.payment_id,
      status: payment.status,
      explanation: payment.decision.user_explanation,
      ...(payment.receipt ? { receipt: payment.receipt } : {}),
      ...(payment.error ? { error: payment.error } : {}),
    };
  }

  async listMyPayments(limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ConnectorError("Limit must be an integer from 1 to 100");
    }
    const result = await this.agentRequest(
      `/v1/agent/payments?limit=${limit}`,
      "GET",
    );
    if (result.status !== 200) this.gatewayError(result);
    return PaymentHistoryResponseSchema.parse(result.data);
  }
}
