"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { formatCny } from "../../lib/catalog";
import type { Cart } from "../../lib/store";

export default function CartPage() {
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
  async function act(operation: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/shop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation,
          ...(operation === "checkout" ? { shipping_profile: "default" } : {}),
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
        Checkout creates a signed request. It does not move simulated money
        until WeBank approves it.
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
                <strong>{formatCny(item.line_total.amount)}</strong>
              </div>
            ))}
          </div>
          <div className="cart-total">
            <span>Total</span>
            <strong>{formatCny(cart.total.amount)}</strong>
          </div>
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
              disabled={busy}
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
