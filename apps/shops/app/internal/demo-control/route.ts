import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import {
  advanceDemoClock,
  demoScenarios,
  resetDemo,
  setDemoPrice,
  setDemoScenario,
} from "../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  const token = process.env.SHOP_OPERATOR_TOKEN;
  const bearer = request.headers.get("authorization");
  if (!token || !bearer?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(bearer.slice(7));
  const expected = Buffer.from(token);
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

export async function POST(request: NextRequest) {
  if (!["127.0.0.1", "localhost", "::1"].includes(request.nextUrl.hostname))
    return NextResponse.json(
      { error: { message: "Operator controls require loopback" } },
      { status: 403 },
    );
  if (!authorized(request))
    return NextResponse.json(
      { error: { message: "Operator token required" } },
      { status: 401 },
    );

  try {
    const body = (await request.json()) as Record<string, unknown>;
    switch (body.operation) {
      case "set_scenario":
        if (body.scenario === "drill")
          return NextResponse.json(
            { error: { message: "Use the WeBank owner app for fire drills" } },
            { status: 403 },
          );
        if (body.scenario !== "attack")
          throw new Error("Unknown demo scenario");
        if (typeof body.enabled !== "boolean")
          throw new Error("Demo scenario enabled must be boolean");
        return NextResponse.json({
          scenarios: { attack: setDemoScenario("attack", body.enabled).attack },
        });
      case "set_price":
        return NextResponse.json({
          product: setDemoPrice(String(body.sku || ""), Number(body.amount)),
        });
      case "advance_clock":
        return NextResponse.json({
          now: advanceDemoClock(Number(body.minutes)),
        });
      case "reset":
        if (demoScenarios().drill)
          return NextResponse.json(
            { error: { message: "Stop the bank fire drill before resetting" } },
            { status: 409 },
          );
        resetDemo();
        return NextResponse.json({
          ok: true,
          reset: true,
          attack: false,
          coffee_price: 8800,
        });
      default:
        return NextResponse.json(
          { error: { message: "Unknown operator operation" } },
          { status: 400 },
        );
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          message:
            error instanceof Error ? error.message : "Operator action failed",
        },
      },
      { status: 400 },
    );
  }
}
