import { type NextRequest, NextResponse } from "next/server";
import { formatCny, type ShopId, shops } from "../../../lib/catalog";
import {
  addToCart,
  checkout,
  clearCart,
  demoClock,
  demoScenarios,
  getCart,
  getOrder,
  listProducts,
  productBySku,
  removeFromCart,
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
          ).map(({ sku, shop, name, price, rating, summary, match }) => ({
            sku,
            shop,
            shop_name: shops[shop].name,
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
          shop: order.shop,
          shop_name: shops[order.shop].name,
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
        return NextResponse.json({
          scenarios: { attack: demoScenarios().attack },
        });
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
      case "remove_from_cart":
        return agentResponse({ cart: removeFromCart(String(body.sku || "")) });
      case "clear_cart":
        return NextResponse.json({ cart: clearCart() });
      case "checkout":
        return agentResponse(checkout(body.shipping_address));
      case "set_scenario":
      case "set_price":
      case "advance_clock":
      case "reset":
        return NextResponse.json(
          { error: { message: "Use the operator demo controls" } },
          { status: 403 },
        );
      default:
        throw new Error("Unknown operation");
    }
  } catch (error) {
    return responseError(error);
  }
}
