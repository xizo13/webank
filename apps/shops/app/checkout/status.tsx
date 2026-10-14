"use client";

import { useEffect, useState } from "react";

export function OrderStatus({
  orderId,
  initialStatus,
}: {
  orderId: string;
  initialStatus: string;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [tx, setTx] = useState<string | undefined>();
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/shop?operation=get_order&order_id=${encodeURIComponent(orderId)}`,
          { cache: "no-store" },
        );
        const order = await response.json();
        if (active && response.ok) {
          setStatus(order.status);
          setTx(order.payment_tx);
        }
      } catch {
        /* Retry on the next poll. */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [orderId]);
  return (
    <div className={`order-status ${status === "paid" ? "paid" : ""}`}>
      <span className="status-dot" />
      <div>
        <strong>
          {status === "paid" ? "Payment confirmed" : "Awaiting WeBank decision"}
        </strong>
        <p>
          {status === "paid"
            ? "The simulated order is paid."
            : "No simulated funds have moved yet."}
        </p>
        {tx && <code>{tx}</code>}
      </div>
    </div>
  );
}
