import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PaymentRequest } from "@webank/contracts";
import {
  getProduct,
  money,
  type Product,
  products,
  type ShopId,
  shops,
} from "./catalog";
import { encodePaymentUri, freshNonce, signPaymentRequest } from "./signing";

export type CartItem = {
  sku: string;
  qty: number;
  options: { size?: string; colour?: string };
};
export type Cart = {
  shop: ShopId | null;
  items: Array<
    CartItem & {
      product: Product;
      unit_price: ReturnType<typeof money>;
      line_total: ReturnType<typeof money>;
    }
  >;
  total: ReturnType<typeof money>;
};
export type Order = {
  order_id: string;
  merchant_id: string;
  shop: ShopId;
  status: "awaiting_payment" | "paid" | "shipped";
  items: Array<CartItem & { unit_price: ReturnType<typeof money> }>;
  total: ReturnType<typeof money>;
  payment_request: string;
  expires_at: string;
  payment_tx?: string;
};
type State = {
  cart: CartItem[];
  orders: Record<string, Order>;
  prices: Record<string, number>;
  clockOffsetMs: number;
};

const dataDir = () =>
  process.env.SHOP_DATA_DIR || join(process.cwd(), ".shop-local");
const statePath = () => join(dataDir(), "state.json");
const emptyState = (): State => ({
  cart: [],
  orders: {},
  prices: {},
  clockOffsetMs: 0,
});

function readState(): State {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  if (!existsSync(statePath())) return emptyState();
  return JSON.parse(readFileSync(statePath(), "utf8")) as State;
}

function saveState(state: State): void {
  const temp = `${statePath()}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temp, statePath());
}

const now = (state: State) => new Date(Date.now() + state.clockOffsetMs);
export const demoClock = () => now(readState()).toISOString();

export function listProducts(
  query = "",
  maxPrice?: number,
  shop?: ShopId,
): Array<Product & { price: number }> {
  const state = readState();
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return products
    .filter((product) => {
      const haystack =
        `${product.name} ${product.brand} ${product.summary} ${product.description} ${product.category} ${product.specs ? Object.values(product.specs).join(" ") : ""}`.toLowerCase();
      const price = state.prices[product.sku] ?? product.price;
      return (
        (!shop || product.shop === shop) &&
        words.every((word) => haystack.includes(word)) &&
        (maxPrice === undefined || price <= maxPrice)
      );
    })
    .map((product) => ({
      ...product,
      price: state.prices[product.sku] ?? product.price,
    }));
}

export function productBySku(sku: string): Product | undefined {
  const product = getProduct(sku);
  if (!product) return undefined;
  const state = readState();
  return { ...product, price: state.prices[sku] ?? product.price };
}

export function getCart(): Cart {
  const state = readState();
  const items = state.cart.map((entry) => {
    const product = productBySku(entry.sku);
    if (!product) throw new Error(`Unknown product in cart: ${entry.sku}`);
    return {
      ...entry,
      product,
      unit_price: money(product.price),
      line_total: money(product.price * entry.qty),
    };
  });
  return {
    shop: items[0]?.product.shop ?? null,
    items,
    total: money(items.reduce((sum, item) => sum + item.line_total.amount, 0)),
  };
}

export function addToCart(
  sku: string,
  qty: number,
  options: CartItem["options"] = {},
): Cart {
  const product = productBySku(sku);
  if (!product) throw new Error("Product not found");
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > 10)
    throw new Error("Quantity must be between 1 and 10");
  if (options.size && !product.sizes.includes(options.size))
    throw new Error("Invalid size");
  if (options.colour && !product.colours.includes(options.colour))
    throw new Error("Invalid colour");
  const state = readState();
  const firstItem = state.cart[0];
  const currentShop = firstItem ? getProduct(firstItem.sku)?.shop : undefined;
  if (currentShop && currentShop !== product.shop)
    throw new Error(
      "Cart contains a different merchant. Clear it before switching stores.",
    );
  const existing = state.cart.find(
    (item) =>
      item.sku === sku &&
      JSON.stringify(item.options) === JSON.stringify(options),
  );
  if (existing) existing.qty = Math.min(10, existing.qty + qty);
  else state.cart.push({ sku, qty, options });
  saveState(state);
  return getCart();
}

export function clearCart(): Cart {
  const state = readState();
  state.cart = [];
  saveState(state);
  return getCart();
}

export function checkout(shippingProfile: "default" = "default"): {
  order_id: string;
  total: ReturnType<typeof money>;
  payment_request: string;
  expires_at: string;
} {
  if (shippingProfile !== "default")
    throw new Error("Only the default demo shipping profile is supported");
  const state = readState();
  if (!state.cart.length) throw new Error("Cart is empty");
  const cart = getCart();
  const shop = cart.shop;
  if (!shop) throw new Error("Cart merchant is missing");
  const order_id = `ord_${randomUUID().replaceAll("-", "")}`;
  const expires_at = new Date(now(state).getTime() + 15 * 60_000).toISOString();
  const unsigned: Omit<PaymentRequest, "merchant_sig"> = {
    schema: "payreq.v1",
    merchant_id: shops[shop].merchantId,
    order_id,
    amount: cart.total,
    line_items: cart.items.map((item) => ({
      sku: item.sku,
      gtin: item.product.gtin,
      name: item.product.name,
      condition: item.product.condition,
      qty: item.qty,
      unit_price: item.unit_price,
    })),
    expires_at,
    nonce: freshNonce(),
  };
  const payment_request = encodePaymentUri(signPaymentRequest(shop, unsigned));
  const order: Order = {
    order_id,
    merchant_id: shops[shop].merchantId,
    shop,
    status: "awaiting_payment",
    items: cart.items.map(({ sku, qty, options, unit_price }) => ({
      sku,
      qty,
      options,
      unit_price,
    })),
    total: cart.total,
    payment_request,
    expires_at,
  };
  state.orders[order_id] = order;
  state.cart = [];
  saveState(state);
  return { order_id, total: cart.total, payment_request, expires_at };
}

export function getOrder(orderId: string): Order | undefined {
  return readState().orders[orderId];
}

export function confirmPayment(orderId: string, paymentTx: string): Order {
  if (!/^0x[0-9a-fA-F]{64}$/.test(paymentTx))
    throw new Error("Invalid transaction hash");
  const state = readState();
  const order = state.orders[orderId];
  if (!order) throw new Error("Order not found");
  if (order.status === "paid" && order.payment_tx === paymentTx) return order;
  if (order.status !== "awaiting_payment")
    throw new Error("Order already settled");
  order.status = "paid";
  order.payment_tx = paymentTx;
  saveState(state);
  return order;
}

export function setDemoPrice(sku: string, amount: number): Product {
  const product = getProduct(sku);
  if (!product || product.shop === "decoy" || product.shop === "malicious")
    throw new Error("Only normal store products can have demo prices");
  if (!Number.isSafeInteger(amount) || amount < 100 || amount > 100000)
    throw new Error("Invalid price in fen");
  const state = readState();
  state.prices[sku] = amount;
  saveState(state);
  return { ...product, price: amount };
}

export function advanceDemoClock(minutes: number): string {
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > 60 * 24 * 31)
    throw new Error("Clock advance must be 0 to 31 days");
  const state = readState();
  state.clockOffsetMs += minutes * 60_000;
  saveState(state);
  return now(state).toISOString();
}

export function resetDemo(): void {
  saveState(emptyState());
}
