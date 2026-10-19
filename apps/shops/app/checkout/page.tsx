import Image from "next/image";
import Link from "next/link";
import QRCode from "qrcode";
import { formatCny, shops } from "../../lib/catalog";
import { getOrder } from "../../lib/store";
import { OrderStatus } from "./status";

export const dynamic = "force-dynamic";

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>;
}) {
  const orderId = (await searchParams).order || "";
  const order = getOrder(orderId);
  if (!order)
    return (
      <main className="inner-page narrow">
        <h1 className="page-title">Order not found.</h1>
        <Link className="button primary" href="/">
          Back to shop ↗
        </Link>
      </main>
    );
  const qr = await QRCode.toDataURL(order.payment_request, {
    margin: 2,
    width: 280,
    errorCorrectionLevel: "M",
    color: { dark: "#161323", light: "#ffffff" },
  });
  return (
    <main className="inner-page checkout-page">
      <div className="eyebrow dark">CHECKOUT / {order.order_id}</div>
      <h1 className="page-title">Payment request ready.</h1>
      <p className="page-intro">
        The seller has signed this simulated bill. Review the seller, items,
        delivery and total before using the payment request.
      </p>
      <div className="checkout-grid">
        <section className="checkout-card">
          <div className="checkout-card-top">
            <span>PAYMENT REQUEST</span>
            <span>e-CNY SIMULATION</span>
          </div>
          <Image
            src={qr}
            alt="QR code containing this simulated e-CNY payment request"
            className="payment-qr"
            width={280}
            height={280}
            unoptimized
          />
          <strong>{formatCny(order.total.amount)}</strong>
          <p>Scan the QR code or copy the payment request URI.</p>
          <div className="uri-box">{order.payment_request}</div>
          <div className="tiny-note">
            Signed by {shops[order.shop].name}. Expires{" "}
            {new Date(order.expires_at).toLocaleString()}.
          </div>
        </section>
        <section className="order-summary">
          <div className="eyebrow dark">ORDER SUMMARY</div>
          <h2>{shops[order.shop].name}</h2>
          <div className="summary-list">
            {order.items.map((item) => (
              <div key={`${item.sku}-${JSON.stringify(item.options)}`}>
                <span>
                  {item.sku}
                  {Object.keys(item.options).length > 0
                    ? ` (${[item.options.colour, item.options.size].filter(Boolean).join(" / ")})`
                    : ""}{" "}
                  × {item.qty}
                </span>
                <span>{formatCny(item.qty * item.unit_price.amount)}</span>
              </div>
            ))}
            {order.shipping_fee && (
              <div>
                <span>Standard delivery</span>
                <span>{formatCny(order.shipping_fee.amount)}</span>
              </div>
            )}
          </div>
          <div className="summary-total">
            <span>Total</span>
            <strong>{formatCny(order.total.amount)}</strong>
          </div>
          <div className="shipping-address-summary">
            <strong>Shipping to</strong>
            {order.shipping_address ? (
              <p>
                {order.shipping_address.name} · {order.shipping_address.phone}
                <br />
                {order.shipping_address.address_line}
                <br />
                {order.shipping_address.city} {order.shipping_address.postcode}
              </p>
            ) : (
              <p>Address was not recorded for this earlier demo order.</p>
            )}
          </div>
          <OrderStatus orderId={order.order_id} initialStatus={order.status} />
          <Link href="/" className="text-link">
            Continue shopping ↗
          </Link>
        </section>
      </div>
    </main>
  );
}
