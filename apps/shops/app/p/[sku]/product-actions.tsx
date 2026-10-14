"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ProductActions({
  sku,
  sizes,
  colours,
}: {
  sku: string;
  sizes: string[];
  colours: string[];
}) {
  const router = useRouter();
  const [size, setSize] = useState(sizes[0] || "");
  const [colour, setColour] = useState(colours[0] || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function add() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/shop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "add_to_cart",
          sku,
          qty: 1,
          options: { ...(size ? { size } : {}), ...(colour ? { colour } : {}) },
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message || "Could not add to cart");
      router.push("/cart");
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not add to cart",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="buy-controls">
      {sizes.length > 0 && (
        <label>
          Size
          <select
            value={size}
            onChange={(event) => setSize(event.target.value)}
          >
            {sizes.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      )}
      {colours.length > 0 && (
        <label>
          Colour
          <select
            value={colour}
            onChange={(event) => setColour(event.target.value)}
          >
            {colours.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      )}
      <button
        type="button"
        className="button primary full"
        onClick={add}
        disabled={busy}
      >
        {busy ? "Adding..." : "Add to cart"} <span>↗</span>
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
