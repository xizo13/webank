import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type JsonWebKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaymentRequest } from "@webank/contracts";
import { PaymentRequestSchema } from "@webank/contracts";
import { type ShopId, shops } from "./catalog";

const dataDir = () =>
  process.env.SHOP_DATA_DIR || join(process.cwd(), ".shop-local");
const keyPath = () => join(dataDir(), "merchant-keys.json");

type KeyStore = Record<ShopId, JsonWebKey>;

function keys(): KeyStore {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  if (existsSync(keyPath()))
    return JSON.parse(readFileSync(keyPath(), "utf8")) as KeyStore;
  const keyStore = {} as KeyStore;
  for (const shop of Object.keys(shops) as ShopId[]) {
    const { privateKey } = generateKeyPairSync("ed25519");
    keyStore[shop] = privateKey.export({ format: "jwk" });
  }
  writeFileSync(keyPath(), JSON.stringify(keyStore, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  return keyStore;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function unsignedPaymentBytes(
  request: Omit<PaymentRequest, "merchant_sig"> | PaymentRequest,
): Buffer {
  const { merchant_sig: _signature, ...unsigned } = request as PaymentRequest;
  return Buffer.from(canonicalJson(unsigned), "utf8");
}

export function merchantPublicKeyHex(shop: ShopId): `0x${string}` {
  const publicJwk = createPublicKey(
    createPrivateKey({ key: keys()[shop], format: "jwk" }),
  ).export({ format: "jwk" });
  if (!publicJwk.x) throw new Error("Missing Ed25519 x coordinate");
  return `0x${Buffer.from(publicJwk.x, "base64url").toString("hex")}`;
}

export function signPaymentRequest(
  shop: ShopId,
  unsigned: Omit<PaymentRequest, "merchant_sig">,
): PaymentRequest {
  if (unsigned.merchant_id !== shops[shop].merchantId)
    throw new Error("Merchant ID does not match signing key");
  const privateKey = createPrivateKey({ key: keys()[shop], format: "jwk" });
  const merchant_sig = sign(
    null,
    unsignedPaymentBytes(unsigned),
    privateKey,
  ).toString("base64url");
  return PaymentRequestSchema.parse({ ...unsigned, merchant_sig });
}

export function encodePaymentUri(request: PaymentRequest): string {
  return `ecny://pay?d=${Buffer.from(JSON.stringify(request), "utf8").toString("base64url")}`;
}

export function decodePaymentUri(uri: string): PaymentRequest {
  const parsed = new URL(uri);
  if (parsed.protocol !== "ecny:" || parsed.hostname !== "pay")
    throw new Error("Invalid payment URI");
  const encoded = parsed.searchParams.get("d");
  if (!encoded) throw new Error("Missing payment request");
  return PaymentRequestSchema.parse(
    JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
  );
}

export function verifyLocalPaymentUri(uri: string): boolean {
  const request = decodePaymentUri(uri);
  const shop = (Object.keys(shops) as ShopId[]).find(
    (candidate) => shops[candidate].merchantId === request.merchant_id,
  );
  if (!shop) return false;
  const rawPublic = Buffer.from(merchantPublicKeyHex(shop).slice(2), "hex");
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: rawPublic.toString("base64url") },
    format: "jwk",
  });
  return verify(
    null,
    unsignedPaymentBytes(request),
    publicKey,
    Buffer.from(request.merchant_sig, "base64url"),
  );
}

export function freshNonce(): string {
  return randomBytes(24).toString("base64url");
}
