import { type NextRequest, NextResponse } from "next/server";
import { setDemoScenario } from "../../../lib/store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requiredToken = process.env.SHOP_INTERNAL_TOKEN;
  if (
    !requiredToken ||
    request.headers.get("authorization") !== `Bearer ${requiredToken}`
  )
    return NextResponse.json(
      { error: { message: "Internal token required" } },
      { status: 401 },
    );

  try {
    const body = (await request.json()) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean")
      return NextResponse.json(
        { error: { message: "enabled must be boolean" } },
        { status: 400 },
      );
    const scenarios = setDemoScenario("drill", body.enabled);
    return NextResponse.json({ drill_visible: scenarios.drill });
  } catch {
    return NextResponse.json(
      { error: { message: "Could not update drill visibility" } },
      { status: 400 },
    );
  }
}
