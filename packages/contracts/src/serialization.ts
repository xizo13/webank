import { PaymentRequestUriSchema } from "./api.js";
import { type PaymentRequest, PaymentRequestSchema } from "./records.js";

/** Encodes a validated merchant payload for the QR and connector handoff. */
export function encodePaymentRequestUri(value: unknown): string {
  const payload = PaymentRequestSchema.parse(value);
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `ecny://pay?d=${encoded}`;
}

/** Decodes and validates the payload; signature verification remains with the Gateway. */
export function decodePaymentRequestUri(value: unknown): PaymentRequest {
  const uri = PaymentRequestUriSchema.parse(value);
  const encoded = uri
    .slice("ecny://pay?d=".length)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  let payload: unknown;
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new Error("Invalid payment request encoding");
  }
  return PaymentRequestSchema.parse(payload);
}
