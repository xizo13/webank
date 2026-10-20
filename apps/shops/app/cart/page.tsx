"use client";

import type { ShippingAddress } from "@webank/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatCny } from "../../lib/catalog";
import type { Cart } from "../../lib/store";

export default function CartPage() {
  const [address, setAddress] = useState<ShippingAddress>({
    name: "Lin Demo",
    phone: "13800138000",
    address_line: "88 Demo Road",
    city: "Shenzhen",
    postcode: "518000",
  });
  const [addressConfirmed, setAddressConfirmed] = useState(false);
  const router = useRouter();
  const [cart, setCart] = useState<Cart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void fetch("/api/shop?operation=get_cart", { cache: "no-store" })
      .then((response) => response.json())
      .then((result) => {
        if (active) setCart(result.cart);
      });
    return () => {
      active = false;
    };
  }, []);
  async function act(
    operation: "checkout" | "clear_cart" | "remove_from_cart",
    sku?: string,
  ) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/shop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation,
          ...(operation === "remove_from_cart" ? { sku } : {}),
          ...(operation === "checkout" ? { shipping_address: address } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message || "Cart action failed");
      if (operation === "checkout")
        router.push(`/checkout?order=${encodeURIComponent(result.order_id)}`);
      else setCart(result.cart);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cart action failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="inner-page narrow">
      <div className="eyebrow dark">YOUR DEMO BAG</div>
      <h1 className="page-title">Your cart.</h1>
      <p className="page-intro">
        Checkout creates a merchant-signed payment request. No simulated funds
        move at checkout.
      </p>
      {!cart ? (
        <p>Loading cart...</p>
      ) : cart.items.length === 0 ? (
        <div className="empty">
          <p>Your cart is empty.</p>
          <Link className="button primary" href="/">
            Explore products ↗
          </Link>
        </div>
      ) : (
        <>
          <p className="cart-seller">Sold by {cart.shop_name}</p>
          <div className="cart-lines">
            {cart.items.map((item) => (
              <div
                className="cart-line"
                key={`${item.sku}-${JSON.stringify(item.options)}`}
              >
                <div className="cart-thumbnail">
                  {item.product.image === "headphones"
                    ? "◉"
                    : item.product.image === "coffee"
                      ? "◒"
                      : "✳"}
                </div>
                <div>
                  <Link href={`/p/${item.sku}`}>
                    <strong>{item.product.name}</strong>
                  </Link>
                  <p>
                    {item.options.size || ""} {item.options.colour || ""} · Qty{" "}
                    {item.qty}
                  </p>
                  <small>{item.product.sku}</small>
                </div>
                <div className="cart-line-action">
                  <strong>{formatCny(item.line_total.amount)}</strong>
                  <button
                    type="button"
                    className="cart-remove"
                    onClick={() => void act("remove_from_cart", item.sku)}
                    disabled={busy}
                    aria-label={`Remove ${item.product.name} (${item.sku}) from cart`}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="cart-total">
            <span>Items</span>
            <strong>{formatCny(cart.total.amount)}</strong>
          </div>
          <section className="shipping-form">
            <div className="eyebrow dark">SHIPPING ADDRESS</div>
            <h2>Confirm where this order goes.</h2>
            <p>
              Sample address for this demo. Check or replace it before the
              payment request is signed.
            </p>
            <div className="shipping-fields">
              {(
                [
                  ["name", "Recipient"],
                  ["phone", "Phone"],
                  ["address_line", "Street address"],
                  ["city", "City"],
                  ["postcode", "Postcode"],
                ] as const
              ).map(([field, label]) => (
                <label key={field}>
                  {label}
                  <input
                    value={address[field]}
                    onChange={(event) => {
                      setAddress((current) => ({
                        ...current,
                        [field]: event.target.value,
                      }));
                      setAddressConfirmed(false);
                    }}
                    required
                  />
                </label>
              ))}
            </div>
            <label className="shipping-confirm">
              <input
                type="checkbox"
                checked={addressConfirmed}
                onChange={(event) => setAddressConfirmed(event.target.checked)}
              />
              I confirm this shipping address.
            </label>
            <p>
              Standard delivery:{" "}
              {formatCny(
                cart.shop === "shopA" || cart.shop === "shopB" ? 500 : 0,
              )}
              . The signed payment total includes delivery.
            </p>
          </section>
          <div className="cart-actions">
            <button
              type="button"
              className="button ghost dark-ghost"
              onClick={() => void act("clear_cart")}
              disabled={busy}
            >
              Clear cart
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => void act("checkout")}
              disabled={
                busy ||
                !addressConfirmed ||
                Object.values(address).some((value) => !value.trim())
              }
            >
              {busy ? "Working..." : "Continue to checkout ↗"}
            </button>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </main>
  );
}
