import { type NextRequest, NextResponse } from "next/server";
import { setDemoPrice } from "../../../lib/store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const { sku, amount } = (await request.json()) as {
      sku?: string;
      amount?: number;
    };
    return NextResponse.json({
      product: setDemoPrice(sku || "", Number(amount)),
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
