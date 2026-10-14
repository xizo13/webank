import type { GatewayDependencies } from "./types.js";

/** Only the local shop's authenticated, loopback-only confirmation endpoint is supported. */
export function createShopPaymentNotifier(input: {
  shopOrigin: string;
  internalToken: string;
  fetcher?: typeof fetch;
}): NonNullable<GatewayDependencies["notifyMerchantPayment"]> {
  const origin = new URL(input.shopOrigin);
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error("Shop callback requires a 127.0.0.1 HTTP origin");
  if (!input.internalToken || /[\r\n]/.test(input.internalToken))
    throw new Error("SHOP_INTERNAL_TOKEN is required");
  const fetcher = input.fetcher ?? fetch;
  return async ({ orderId, paymentTx }) => {
    const response = await fetcher(
      new URL("/internal/payment-confirmed", origin).toString(),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.internalToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ order_id: orderId, payment_tx: paymentTx }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) throw new Error("Shop confirmation was rejected");
    const result: unknown = await response.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("order_id" in result) ||
      !("status" in result) ||
      !("payment_tx" in result) ||
      result.order_id !== orderId ||
      result.status !== "paid" ||
      result.payment_tx !== paymentTx
    )
      throw new Error("Shop confirmation did not match the payment");
  };
}
