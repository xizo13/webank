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
      <h1 className="page-title">Ready for WeBank.</h1>
      <p className="page-intro">
        The merchant has signed the bill. Your agent can carry it to WeBank,
        where the wallet checks the actual payee, items and mandate.
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
          <p>Scan or hand the URI to the WeBank connector.</p>
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
              <div key={item.sku}>
                <span>
                  {item.sku} × {item.qty}
                </span>
                <span>{formatCny(item.qty * item.unit_price.amount)}</span>
              </div>
            ))}
          </div>
          <div className="summary-total">
            <span>Total</span>
            <strong>{formatCny(order.total.amount)}</strong>
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
