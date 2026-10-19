import { type NextRequest, NextResponse } from "next/server";
import { formatCny, type ShopId, shops } from "../../../lib/catalog";
import {
  addToCart,
  advanceDemoClock,
  checkout,
  clearCart,
  demoClock,
  demoScenarios,
  getCart,
  getOrder,
  listProducts,
  productBySku,
  resetDemo,
  setDemoPrice,
  setDemoScenario,
} from "../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function responseError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown shop error";
  return NextResponse.json(
    { error: { message } },
    { status: /not found/i.test(message) ? 404 : 400 },
  );
}

function withMoneyDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withMoneyDisplay);
  if (!value || typeof value !== "object") return value;
  const fields = value as Record<string, unknown>;
  if (
    fields.currency === "CNY" &&
    typeof fields.amount === "number" &&
    Number.isSafeInteger(fields.amount)
  )
    return { ...fields, display: formatCny(fields.amount) };
  return Object.fromEntries(
    Object.entries(fields).map(([key, item]) => [key, withMoneyDisplay(item)]),
  );
}

const agentResponse = (value: unknown) =>
  NextResponse.json(withMoneyDisplay(value));

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams;
    switch (query.get("operation")) {
      case "search_products": {
        const max = query.get("max_price");
        const maxPrice = max === null ? undefined : Number(max);
        if (
          maxPrice !== undefined &&
          (!Number.isSafeInteger(maxPrice) || maxPrice < 0)
        )
          throw new Error("Invalid max_price in fen");
        const shop = query.get("shop") || undefined;
        if (shop && !(shop in shops)) throw new Error("Unknown shop");
        return agentResponse(
          listProducts(
            query.get("query") || "",
            maxPrice,
            shop as ShopId | undefined,
          ).map(({ sku, name, price, rating, summary, match }) => ({
            sku,
            name,
            price: { amount: price, currency: "CNY" },
            rating,
            summary,
            match,
          })),
        );
      }
      case "get_product": {
        const product = productBySku(query.get("sku") || "");
        if (!product) throw new Error("Product not found");
        return agentResponse({
          ...product,
          price: { amount: product.price, currency: "CNY" },
        });
      }
      case "get_cart":
        return agentResponse({ cart: getCart() });
      case "get_order": {
        const order = getOrder(query.get("order_id") || "");
        if (!order) throw new Error("Order not found");
        return agentResponse({
          order_id: order.order_id,
          status: order.status,
          items: order.items,
          total: order.total,
          shipping_address: order.shipping_address,
          shipping_fee: order.shipping_fee,
          payment_tx: order.payment_tx,
        });
      }
      case "clock":
        return NextResponse.json({ now: demoClock() });
      case "scenarios":
        return NextResponse.json({ scenarios: demoScenarios() });
      default:
        throw new Error("Unknown operation");
    }
  } catch (error) {
    return responseError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    switch (body.operation) {
      case "add_to_cart":
        return agentResponse({
          cart: addToCart(
            String(body.sku || ""),
            Number(body.qty),
            (body.options || {}) as { size?: string; colour?: string },
          ),
        });
      case "clear_cart":
        return NextResponse.json({ cart: clearCart() });
      case "checkout":
        return agentResponse(checkout(body.shipping_address));
      case "set_scenario": {
        if (body.scenario !== "attack" && body.scenario !== "drill")
          throw new Error("Unknown demo scenario");
        if (typeof body.enabled !== "boolean")
          throw new Error("Demo scenario enabled must be boolean");
        return NextResponse.json({
          scenarios: setDemoScenario(body.scenario, body.enabled),
        });
      }
      case "set_price":
        return NextResponse.json({
          product: setDemoPrice(String(body.sku || ""), Number(body.amount)),
        });
      case "advance_clock":
        return NextResponse.json({
          now: advanceDemoClock(Number(body.minutes)),
        });
      case "reset":
        resetDemo();
        return NextResponse.json({ ok: true });
      default:
        throw new Error("Unknown operation");
    }
  } catch (error) {
    return responseError(error);
  }
}
