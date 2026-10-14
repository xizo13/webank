import { type NextRequest, NextResponse } from "next/server";
import { confirmPayment } from "../../../lib/store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requiredToken = process.env.SHOP_INTERNAL_TOKEN;
  if (
    !requiredToken ||
    request.headers.get("authorization") !== `Bearer ${requiredToken}`
  ) {
    return NextResponse.json(
      { error: { message: "Internal token required" } },
      { status: 401 },
    );
  }
  try {
    const body = (await request.json()) as {
      order_id?: string;
      payment_tx?: string;
    };
    const order = confirmPayment(body.order_id || "", body.payment_tx || "");
    return NextResponse.json({
      order_id: order.order_id,
      status: order.status,
      payment_tx: order.payment_tx,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : "Unknown error",
        },
      },
      { status: 400 },
    );
  }
}
