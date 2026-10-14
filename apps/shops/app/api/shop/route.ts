import { type NextRequest, NextResponse } from "next/server";
import { type ShopId, shops } from "../../../lib/catalog";
import {
  addToCart,
  advanceDemoClock,
  checkout,
  clearCart,
  demoClock,
  getCart,
  getOrder,
  listProducts,
  productBySku,
  resetDemo,
  setDemoPrice,
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
        return NextResponse.json(
          listProducts(
            query.get("query") || "",
            maxPrice,
            shop as ShopId | undefined,
          ).map(({ sku, name, price, rating, summary }) => ({
            sku,
            name,
            price: { amount: price, currency: "CNY" },
            rating,
            summary,
          })),
        );
      }
      case "get_product": {
        const product = productBySku(query.get("sku") || "");
        if (!product) throw new Error("Product not found");
        return NextResponse.json({
          ...product,
          price: { amount: product.price, currency: "CNY" },
        });
      }
      case "get_cart":
        return NextResponse.json({ cart: getCart() });
      case "get_order": {
        const order = getOrder(query.get("order_id") || "");
        if (!order) throw new Error("Order not found");
        return NextResponse.json({
          order_id: order.order_id,
          status: order.status,
          items: order.items,
          total: order.total,
          payment_tx: order.payment_tx,
        });
      }
      case "clock":
        return NextResponse.json({ now: demoClock() });
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
        return NextResponse.json({
          cart: addToCart(
            String(body.sku || ""),
            Number(body.qty),
            (body.options || {}) as { size?: string; colour?: string },
          ),
        });
      case "clear_cart":
        return NextResponse.json({ cart: clearCart() });
      case "checkout":
        return NextResponse.json(checkout(body.shipping_profile as "default"));
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
