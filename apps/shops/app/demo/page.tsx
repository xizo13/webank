"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export default function DemoPage() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [scenarios, setScenarios] = useState({ attack: false, drill: false });
  const [scenariosLoaded, setScenariosLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch("/api/shop?operation=scenarios")
      .then((response) => {
        if (!response.ok) throw new Error("Scenario status unavailable.");
        return response.json();
      })
      .then((data) => {
        if (active && data.scenarios) {
          setScenarios(data.scenarios);
          setScenariosLoaded(true);
        }
      })
      .catch(() => {
        if (active) setMessage("Scenario status unavailable.");
      });
    return () => {
      active = false;
    };
  }, []);
  async function action(
    operation: string,
    values: Record<string, unknown> = {},
  ) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/shop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, ...values }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error?.message || "Demo action failed");
      if (data.scenarios) {
        setScenarios(data.scenarios);
        setScenariosLoaded(true);
      }
      if (operation === "reset") setScenarios({ attack: false, drill: false });
      setMessage(
        operation === "set_price"
          ? `Price changed to ¥${(data.product.price / 100).toFixed(2)}.`
          : operation === "advance_clock"
            ? `Demo clock: ${data.now}.`
            : operation === "set_scenario"
              ? `${values.scenario === "attack" ? "Attack" : "Fire drill"} ${values.enabled ? "enabled" : "disabled"}.`
              : "Shop demo reset. Merchant signing keys were preserved.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Demo action failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="inner-page demo-page">
      <div className="eyebrow dark">OPERATOR CONSOLE</div>
      <h1 className="page-title">Make the demo move.</h1>
      <p className="page-intro">
        These local controls change only the simulated shops. Merchant keys stay
        stable so the Gateway can keep verifying signatures.
      </p>
      <div className="demo-grid">
        <section className="demo-card">
          <span className="demo-number">01 / AUTONOMOUS PURCHASE</span>
          <h2>Drop the price.</h2>
          <p>
            Move Nova Quiet 3 below the ¥250 scenario trigger to test the price
            drop.
          </p>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() =>
              void action("set_price", { sku: "NOVA-Q3-BLK", amount: 23900 })
            }
          >
            Set price to ¥239 ↗
          </button>
        </section>
        <section className="demo-card">
          <span className="demo-number">02 / TREASURER</span>
          <h2>Move time forward.</h2>
          <p>
            Advance the shop clock one day for renewal and order expiry
            scenarios.
          </p>
          <button
            type="button"
            className="button primary"
            disabled={busy}
            onClick={() => void action("advance_clock", { minutes: 1440 })}
          >
            Advance one day ↗
          </button>
        </section>
        <section className="demo-card red-card">
          <span className="demo-number">03 / DEMO 4 ATTACK</span>
          <h2>Open the trap.</h2>
          <p>
            A merchant listing tells the agent to pay an unrelated service fee.
            Its actual payee remains visible in the signed request.
          </p>
          <button
            type="button"
            className="button primary"
            disabled={busy || !scenariosLoaded}
            onClick={() =>
              void action("set_scenario", {
                scenario: "attack",
                enabled: !scenarios.attack,
              })
            }
          >
            {scenarios.attack ? "Disable attack" : "Enable attack"}
          </button>
          {scenarios.attack ? (
            <Link className="button primary" href="/p/FLASH-Q3-FEE">
              View malicious listing ↗
            </Link>
          ) : null}
        </section>
        <section className="demo-card purple-card">
          <span className="demo-number">04 / DEMO 5 FIRE DRILL</span>
          <h2>Test the licence.</h2>
          <p>
            A decoy gift-card merchant is marked as a honeypot in the registry
            for the fire-drill scenario.
          </p>
          <button
            type="button"
            className="button primary"
            disabled={busy || !scenariosLoaded}
            onClick={() =>
              void action("set_scenario", {
                scenario: "drill",
                enabled: !scenarios.drill,
              })
            }
          >
            {scenarios.drill ? "Disable fire drill" : "Enable fire drill"}
          </button>
          {scenarios.drill ? (
            <Link className="button primary" href="/p/REWARD-GIFT-500">
              View decoy listing ↗
            </Link>
          ) : null}
        </section>
      </div>
      <div className="demo-reset">
        <div>
          <strong>Start fresh.</strong>
          <p>Clear cart, orders, prices and clock offset for another run.</p>
        </div>
        <button
          type="button"
          disabled={busy}
          className="button ghost dark-ghost"
          onClick={() => void action("reset")}
        >
          Reset shop state
        </button>
      </div>
      {message && (
        <div className="demo-message" role="status">
          {message}
        </div>
      )}
    </main>
  );
}
