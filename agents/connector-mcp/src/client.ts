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
  PaidPaymentResponseSchema,
  PaymentHistoryResponseSchema,
  PaymentStatusResponseSchema,
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
  ): Promise<{ status: number; data: unknown }> {
    const url = new URL(path, this.baseUrl);
    const serialized = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { accept: "application/json" };
    if (method === "POST") headers["content-type"] = "application/json";
    if (auth) {
      if (!auth.agentId || !auth.accessToken) {
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
      headers.authorization = `Bearer ${auth.accessToken}`;
    }
    const response = await this.request(url, {
      method,
      headers,
      ...(method === "POST" ? { body: serialized } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
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
    throw new ConnectorError(
      `WeBank request failed (${result.status}: ${code})`,
      code,
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
    } = {},
  ) {
    const clientName = input.client_name || "Claude";
    const provider = input.provider || "Anthropic";
    const waitSeconds = Math.min(Math.max(input.wait_seconds ?? 0, 0), 20);
    let current = await this.store.load();
    if (current?.agentId && current.accessToken) {
      return { status: "connected", agent_id: current.agentId };
    }
    if (!current?.pending || current.pending.expiresAt <= this.now()) {
      current = newAgentKey();
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
        };
        await this.store.save(connected);
        return { status: "connected", agent_id: tokens.agent_id };
      }
      const pendingError = DeviceTokenErrorSchema.safeParse(result.data);
      if (!pendingError.success) this.gatewayError(result);
      if (pendingError.data.error !== "authorization_pending") {
        await this.store.save({ ...current, pending: undefined });
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

  async createMandate(input: unknown) {
    const body = CreateMandateRequestSchema.parse(input);
    const result = await this.agentRequest("/v1/agent/mandates", "POST", body);
    if (result.status !== 201 && result.status !== 202)
      this.gatewayError(result);
    const response = CreateMandateResponseSchema.parse(result.data);
    return {
      status: response.mandate.status,
      mandate_id: response.mandate.mandate_id,
      ...(response.approval_id ? { approval_id: response.approval_id } : {}),
      message:
        response.mandate.status === "pending_user"
          ? "Awaiting approval in the WeBank app"
          : "Mandate active",
    };
  }

  async requestPayment(input: unknown) {
    const body = CreatePaymentRequestSchema.parse(input);
    const result = await this.agentRequest("/v1/agent/payments", "POST", body);
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
