import { createHash, createPublicKey, verify } from "node:crypto";
import type { PaymentRequest } from "@webank/contracts";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("Unsupported canonical JSON value");
  return encoded;
}

export function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Verifies the mock shop's Ed25519 signature against a registry-sourced raw key. */
export function verifyMerchantSignature(
  request: PaymentRequest,
  publicKeyHex: `0x${string}`,
): boolean {
  try {
    const publicKey = Buffer.from(publicKeyHex.slice(2), "hex");
    const signature = Buffer.from(request.merchant_sig, "base64url");
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    const spki = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      publicKey,
    ]);
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    const { merchant_sig: _signature, ...unsigned } = request;
    return verify(
      null,
      Buffer.from(canonicalJson(unsigned), "utf8"),
      key,
      signature,
    );
  } catch {
    return false;
  }
}
