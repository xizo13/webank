import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";
import type { Agent } from "@webank/contracts";
import type { FastifyRequest } from "fastify";

type TokenEntry = { agentId: string; expiresAt: number };
type AuthResult =
  | { agent: Agent }
  | { error: "bad_signature" | "token_expired" };

const signatureInputPattern =
  /^sig1=(\("@method" "@path" "content-digest" "idempotency-key"\);created=(\d+);expires=(\d+);nonce="([A-Za-z0-9_-]{32})";keyid="(agt_[A-Za-z0-9_-]+)";alg="ecdsa-p256-sha256")$/;
const signaturePattern = /^sig1=:([A-Za-z0-9+/]+={0,2}):$/;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function equalText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class AgentAuth {
  private readonly access = new Map<string, TokenEntry>();
  private readonly refresh = new Map<string, TokenEntry>();
  private readonly nonces = new Map<string, number>();

  snapshot() {
    return {
      access: [...this.access],
      refresh: [...this.refresh],
      nonces: [...this.nonces],
    };
  }

  restore(value: ReturnType<AgentAuth["snapshot"]>): void {
    for (const [key, entry] of value.access) this.access.set(key, entry);
    for (const [key, entry] of value.refresh) this.refresh.set(key, entry);
    for (const [key, until] of value.nonces) this.nonces.set(key, until);
  }

  accessStatus(token: string | undefined, agentId: string, nowMs: number) {
    if (!token) return "missing" as const;
    const entry = this.access.get(hashToken(token));
    if (!entry || entry.agentId !== agentId) return "missing" as const;
    return entry.expiresAt <= nowMs ? ("expired" as const) : ("valid" as const);
  }

  issue(agentId: string, nowMs: number) {
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    this.access.set(hashToken(accessToken), {
      agentId,
      expiresAt: nowMs + 900_000,
    });
    this.refresh.set(hashToken(refreshToken), {
      agentId,
      expiresAt: nowMs + 30 * 86_400_000,
    });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 900 as const,
      agent_id: agentId,
    };
  }

  refreshAgentId(token: string, nowMs: number): string | null {
    const entry = this.refresh.get(hashToken(token));
    return entry && entry.expiresAt > nowMs ? entry.agentId : null;
  }

  hasAccess(
    token: string | undefined,
    agentId: string,
    nowMs: number,
  ): boolean {
    if (!token) return false;
    const entry = this.access.get(hashToken(token));
    return entry?.agentId === agentId && entry.expiresAt > nowMs;
  }

  rotate(token: string, nowMs: number) {
    const key = hashToken(token);
    const entry = this.refresh.get(key);
    if (!entry || entry.expiresAt <= nowMs) return null;
    this.refresh.delete(key);
    return this.issue(entry.agentId, nowMs);
  }

  revokeAgent(agentId: string): void {
    for (const [token, entry] of this.access) {
      if (entry.agentId === agentId) this.access.delete(token);
    }
    for (const [token, entry] of this.refresh) {
      if (entry.agentId === agentId) this.refresh.delete(token);
    }
  }

  revokeAccess(agentId: string): void {
    for (const [token, entry] of this.access) {
      if (entry.agentId === agentId) this.access.delete(token);
    }
  }

  verify(
    request: FastifyRequest,
    rawBody: Uint8Array,
    agents: Map<string, Agent>,
    nowMs: number,
    keyOnly = false,
  ): AuthResult {
    let tokenAgentId: string | undefined;
    if (!keyOnly) {
      const bearer = request.headers.authorization?.match(
        /^Bearer ([A-Za-z0-9_-]+)$/,
      );
      if (!bearer) return { error: "bad_signature" };
      const token = this.access.get(hashToken(bearer[1] ?? ""));
      if (!token) return { error: "bad_signature" };
      if (token.expiresAt <= nowMs) return { error: "token_expired" };
      tokenAgentId = token.agentId;
    }

    const signatureInput = request.headers["signature-input"];
    const signatureHeader = request.headers.signature;
    const digestHeader = request.headers["content-digest"];
    const idempotencyKey = request.headers["idempotency-key"];
    if (
      typeof signatureInput !== "string" ||
      typeof signatureHeader !== "string" ||
      typeof digestHeader !== "string" ||
      typeof idempotencyKey !== "string" ||
      idempotencyKey.length < 1 ||
      idempotencyKey.length > 255
    )
      return { error: "bad_signature" };
    const input = signatureInput.match(signatureInputPattern);
    const encodedSignature = signatureHeader.match(signaturePattern);
    if (!input || !encodedSignature) return { error: "bad_signature" };
    const params = input[1] ?? "";
    const created = Number(input[2]);
    const expires = Number(input[3]);
    const nonce = input[4] ?? "";
    const keyId = input[5] ?? "";
    const agent = agents.get(keyOnly ? keyId : (tokenAgentId ?? ""));
    if (!agent) return { error: "bad_signature" };
    const nowSeconds = Math.floor(nowMs / 1000);
    if (
      !Number.isSafeInteger(created) ||
      !Number.isSafeInteger(expires) ||
      expires <= created ||
      expires - created > 60 ||
      created > nowSeconds + 5 ||
      expires <= nowSeconds ||
      keyId !== agent.agent_id
    )
      return { error: "bad_signature" };
    const expectedDigest = `sha-256=:${createHash("sha256").update(rawBody).digest("base64")}:`;
    if (!equalText(digestHeader, expectedDigest))
      return { error: "bad_signature" };
    const path = new URL(request.url, "http://localhost").pathname;
    const base = [
      `"@method": ${request.method.toUpperCase()}`,
      `"@path": ${path}`,
      `"content-digest": ${digestHeader}`,
      `"idempotency-key": ${idempotencyKey}`,
      `"@signature-params": ${params}`,
    ].join("\n");
    let signatureValid = false;
    try {
      if (!agent.public_key.startsWith("p256:"))
        return { error: "bad_signature" };
      const key = createPublicKey({
        key: Buffer.from(agent.public_key.slice(5), "base64url"),
        format: "der",
        type: "spki",
      });
      if (
        key.asymmetricKeyType !== "ec" ||
        key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
      )
        return { error: "bad_signature" };
      signatureValid = verify(
        "sha256",
        Buffer.from(base, "utf8"),
        key,
        Buffer.from(encodedSignature[1] ?? "", "base64"),
      );
    } catch {
      return { error: "bad_signature" };
    }
    if (!signatureValid) return { error: "bad_signature" };
    for (const [key, until] of this.nonces) {
      if (until <= nowMs) this.nonces.delete(key);
    }
    const nonceKey = `${agent.agent_id}:${nonce}`;
    if (this.nonces.has(nonceKey)) return { error: "bad_signature" };
    this.nonces.set(nonceKey, expires * 1000);
    return { agent };
  }
}
