import { NextResponse } from "next/server";
import { type ShopId, shops } from "../../../lib/catalog";
import { merchantPublicKeyHex } from "../../../lib/signing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const payouts: Record<ShopId, `0x${string}`> = {
  shopA: "0x00000000000000000000000000000000000000a1",
  shopB: "0x00000000000000000000000000000000000000b2",
  malicious: "0x00000000000000000000000000000000000000c3",
  decoy: "0x00000000000000000000000000000000000000d4",
};

export async function GET() {
  return NextResponse.json({
    simulated: true,
    merchants: (Object.keys(shops) as ShopId[]).map((shop) => ({
      merchant_id: shops[shop].merchantId,
      payout: payouts[shop],
      ed25519_public_key: merchantPublicKeyHex(shop),
      legal_name: shops[shop].legalName,
      uscc: shops[shop].uscc,
      category: shops[shop].category,
      active: true,
      honeypot: shops[shop].honeypot,
    })),
  });
}
