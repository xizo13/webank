import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import type { Credentials } from "./storage.js";

export function newAgentKey(): Credentials {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    privateKeyPem: privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
    publicKey: `p256:${publicKey.export({ format: "der", type: "spki" }).toString("base64url")}`,
  };
}

export interface SignedHeaders {
  "content-digest": string;
  "idempotency-key": string;
  "signature-input": string;
  signature: string;
}

/** RFC 9421 signature base for the four components named in api-contracts.md. */
export function signAgentRequest(input: {
  method: string;
  path: string;
  body: string;
  idempotencyKey: string;
  agentId: string;
  privateKeyPem: string;
  now?: number;
  nonce?: string;
}): SignedHeaders {
  const created = Math.floor((input.now ?? Date.now()) / 1000);
  const nonce = input.nonce ?? randomBytes(24).toString("base64url");
  const digest = `sha-256=:${createHash("sha256").update(input.body).digest("base64")}:`;
  const params = `("@method" "@path" "content-digest" "idempotency-key");created=${created};expires=${created + 60};nonce="${nonce}";keyid="${input.agentId}";alg="ecdsa-p256-sha256"`;
  const base = [
    `"@method": ${input.method.toUpperCase()}`,
    `"@path": ${input.path}`,
    `"content-digest": ${digest}`,
    `"idempotency-key": ${input.idempotencyKey}`,
    `"@signature-params": ${params}`,
  ].join("\n");
  const signature = sign(
    "sha256",
    Buffer.from(base),
    createPrivateKey(input.privateKeyPem),
  );
  return {
    "content-digest": digest,
    "idempotency-key": input.idempotencyKey,
    "signature-input": `sig1=${params}`,
    signature: `sig1=:${signature.toString("base64")}:`,
  };
}
