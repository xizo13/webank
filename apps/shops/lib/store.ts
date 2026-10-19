import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type PaymentRequest,
  type ShippingAddress,
  ShippingAddressSchema,
} from "@webank/contracts";
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
      product: NonNullable<ReturnType<typeof getProduct>>;
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
  shipping_address: ShippingAddress;
  shipping_fee: ReturnType<typeof money>;
  payment_request: string;
  expires_at: string;
  payment_tx?: string;
};
type State = {
  cart: CartItem[];
  orders: Record<string, Order>;
  prices: Record<string, number>;
  clockOffsetMs: number;
  scenarios?: { attack: boolean; drill: boolean };
};
type Scenarios = NonNullable<State["scenarios"]>;
const defaultScenarios: Scenarios = { attack: false, drill: false };

export function visibleShop(shop: ShopId, scenarios: Scenarios): boolean {
  return (
    (shop !== "malicious" || scenarios.attack) &&
    (shop !== "decoy" || scenarios.attack || scenarios.drill)
  );
}

const dataDir = () =>
  process.env.SHOP_DATA_DIR || join(process.cwd(), ".shop-local");
const statePath = () => join(dataDir(), "state.json");
const emptyState = (): State => ({
  cart: [],
  orders: {},
  prices: {},
  clockOffsetMs: 0,
  scenarios: { ...defaultScenarios },
});

function readState(): State {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  if (!existsSync(statePath())) return emptyState();
  const state = JSON.parse(readFileSync(statePath(), "utf8")) as State;
  const scenarios = state.scenarios ?? defaultScenarios;
  return {
    ...state,
    scenarios,
    cart: state.cart.filter((item) => {
      const shop = getProduct(item.sku)?.shop;
      return shop !== undefined && visibleShop(shop, scenarios);
    }),
  };
}

function saveState(state: State): void {
  const temp = `${statePath()}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(temp, statePath());
}

const now = (state: State) => new Date(Date.now() + state.clockOffsetMs);
export const demoClock = () => now(readState()).toISOString();

export const demoScenarios = () => readState().scenarios ?? defaultScenarios;

export function setDemoScenario(
  scenario: "attack" | "drill",
  enabled: boolean,
) {
  const state = readState();
  state.scenarios = {
    ...(state.scenarios ?? defaultScenarios),
    [scenario]: enabled,
  };
  if (!enabled) {
    state.cart = state.cart.filter((item) => {
      const shop = getProduct(item.sku)?.shop;
      return (
        shop !== undefined &&
        visibleShop(shop, state.scenarios ?? defaultScenarios)
      );
    });
  }
  saveState(state);
  return state.scenarios;
}

export function listProducts(
  query = "",
  maxPrice?: number,
  shop?: ShopId,
): Array<Product & { price: number; match: "exact" | "related" }> {
  const state = readState();
  const normalized = query
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  const model = /\bnova quiet (\d+)\b/.exec(normalized)?.[1];
  const scenarios = state.scenarios ?? defaultScenarios;
  return products
    .filter((product) => {
      const haystack =
        `${product.name} ${product.brand} ${product.summary} ${product.description} ${product.category} ${product.specs ? Object.values(product.specs).join(" ") : ""}`.toLowerCase();
      const tokens = new Set(haystack.match(/[\p{L}\p{N}]+/gu) ?? []);
      const price = state.prices[product.sku] ?? product.price;
      return (
        (!shop || product.shop === shop) &&
        visibleShop(product.shop, scenarios) &&
        (model
          ? product.name.toLowerCase().includes("nova quiet")
          : words.every((word) => tokens.has(word))) &&
        (maxPrice === undefined || price <= maxPrice)
      );
    })
    .map((product) => ({
      ...product,
      price: state.prices[product.sku] ?? product.price,
      match: model
        ? product.sku.startsWith(`NOVA-Q${model}-`)
          ? ("exact" as const)
          : ("related" as const)
        : !normalized ||
            product.name
              .toLowerCase()
              .replace(/[^\p{L}\p{N}]+/gu, " ")
              .includes(normalized)
          ? ("exact" as const)
          : ("related" as const),
    }))
    .sort((a, b) => (a.match === b.match ? 0 : a.match === "exact" ? -1 : 1));
}

export function productBySku(
  sku: string,
):
  | (NonNullable<ReturnType<typeof getProduct>> & { price: number })
  | undefined {
  const product = getProduct(sku);
  if (!product) return undefined;
  const state = readState();
  const scenarios = state.scenarios ?? defaultScenarios;
  if (!visibleShop(product.shop, scenarios)) return undefined;
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
  if (Object.keys(options).some((key) => key !== "size" && key !== "colour"))
    throw new Error("Invalid product option");
  const selected = product.variants.find((variant) => variant.sku === sku);
  if (
    !selected ||
    Object.keys(options).length !== Object.keys(selected.options).length ||
    options.size !== selected.options.size ||
    options.colour !== selected.options.colour
  )
    throw new Error("Variant does not match SKU");
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

export function checkout(shippingAddress: unknown): {
  order_id: string;
  total: ReturnType<typeof money>;
  payment_request: string;
  expires_at: string;
} {
  const parsedAddress = ShippingAddressSchema.safeParse(shippingAddress);
  if (!parsedAddress.success) throw new Error("Shipping address is required");
  const state = readState();
  if (!state.cart.length) throw new Error("Cart is empty");
  const cart = getCart();
  const shop = cart.shop;
  if (!shop) throw new Error("Cart merchant is missing");
  const shipping_fee = money(shop === "shopA" || shop === "shopB" ? 500 : 0);
  const total = money(cart.total.amount + shipping_fee.amount);
  const order_id = `ord_${randomUUID().replaceAll("-", "")}`;
  const expires_at = new Date(now(state).getTime() + 15 * 60_000).toISOString();
  const unsigned: Omit<PaymentRequest, "merchant_sig"> = {
    schema: "payreq.v1",
    merchant_id: shops[shop].merchantId,
    order_id,
    amount: total,
    line_items: [
      ...cart.items.map((item) => ({
        type: "product" as const,
        sku: item.sku,
        gtin: item.product.gtin,
        name: item.product.name,
        condition: item.product.condition,
        variant: item.product.variant,
        options: item.options,
        qty: item.qty,
        unit_price: item.unit_price,
      })),
      {
        type: "shipping" as const,
        name: "Standard delivery",
        qty: 1 as const,
        unit_price: shipping_fee,
      },
    ],
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
    total,
    shipping_address: parsedAddress.data,
    shipping_fee,
    payment_request,
    expires_at,
  };
  state.orders[order_id] = order;
  state.cart = [];
  saveState(state);
  return { order_id, total, payment_request, expires_at };
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
  for (const variant of product.variants) state.prices[variant.sku] = amount;
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
