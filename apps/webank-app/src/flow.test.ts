import { describe, expect, it } from "vitest";
import {
  applyDemoBiometricApproval,
  enableWallet,
  formatMoney,
  freezeAgent,
  fundWallet,
  initialDemoState,
  matchRequestNumber,
  queueFirstPayment,
  queuePairing,
  simulateBlockedAttack,
} from "./flow";

const now = Date.parse("2026-10-14T12:00:00+08:00");

function connectedAndFunded() {
  let state = fundWallet(enableWallet(initialDemoState()), 100000);
  state = queuePairing(state, now);
  state = matchRequestNumber(state, "apr_pair_claude", "481926", now).state;
  return applyDemoBiometricApproval(state, "apr_pair_claude", true, now + 1000);
}

describe("Agent Wallet demo behavior", () => {
  it("starts a new agent Amber and blocks Red payment requests", () => {
    const state = connectedAndFunded();
    expect(state.agents[0]?.licence.level).toBe("AMBER");
    const red = {
      ...state,
      agents: state.agents.map((agent) => ({
        ...agent,
        licence: {
          ...agent.licence,
          level: "RED" as const,
          reason: "Failed drill",
        },
      })),
    };
    expect(
      queueFirstPayment(red, now + 2000).approvals.some(
        (item) => item.kind === "payment",
      ),
    ).toBe(false);
  });

  it("gives pairing ten minutes and payment approval three minutes", () => {
    const pairing = queuePairing(enableWallet(initialDemoState()), now);
    expect(Date.parse(pairing.approvals[0]?.expires_at ?? "") - now).toBe(
      600_000,
    );
    const funded = connectedAndFunded();
    const payment = queueFirstPayment(funded, now + 2000);
    const card = payment.approvals.find((item) => item.kind === "payment");
    expect(Date.parse(card?.expires_at ?? "") - (now + 2000)).toBe(180_000);
  });

  it("requires the connector number and a fresh biometric result before pairing or payment", () => {
    let state = fundWallet(enableWallet(initialDemoState()), 100000);
    state = queuePairing(state, now);
    expect(
      applyDemoBiometricApproval(state, "apr_pair_claude", true, now + 1000)
        .agents,
    ).toHaveLength(0);
    state = matchRequestNumber(state, "apr_pair_claude", "481926", now).state;
    expect(
      applyDemoBiometricApproval(state, "apr_pair_claude", false, now + 1000)
        .agents,
    ).toHaveLength(0);
    state = applyDemoBiometricApproval(
      state,
      "apr_pair_claude",
      true,
      now + 1000,
    );
    expect(state.agents).toHaveLength(1);

    state = queueFirstPayment(state, now + 2000);
    expect(
      applyDemoBiometricApproval(state, "apr_pay_first", true, now + 3000)
        .walletBalance,
    ).toBe(100000);
    state = matchRequestNumber(
      state,
      "apr_pay_first",
      "739204",
      now + 3000,
    ).state;
    state = applyDemoBiometricApproval(
      state,
      "apr_pay_first",
      true,
      now + 4000,
    );
    expect(state.walletBalance).toBe(72100);
    expect(state.payments).toMatchObject([{ status: "paid", amount: 27900 }]);
  });

  it("cancels a request after three wrong numbers and rejects a late biometric result", () => {
    let state = queuePairing(enableWallet(initialDemoState()), now);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = matchRequestNumber(
        state,
        "apr_pair_claude",
        "111111",
        now + attempt * 1000,
      );
      state = result.state;
      expect(result.result).toBe(attempt === 3 ? "cancelled" : "wrong");
    }
    expect(state.approvals[0]?.status).toBe("rejected");
    expect(
      applyDemoBiometricApproval(state, "apr_pair_claude", true, now + 4000)
        .agents,
    ).toHaveLength(0);

    state = queuePairing(state, now + 5000);
    expect(state.approvals).toHaveLength(1);
    state = matchRequestNumber(
      state,
      "apr_pair_claude",
      "481926",
      now + 6000,
    ).state;
    expect(
      applyDemoBiometricApproval(state, "apr_pair_claude", true, now + 606000)
        .agents,
    ).toHaveLength(0);
  });

  it("keeps the balance unchanged when a poisoned listing is blocked and prevents requests after freeze", () => {
    let state = connectedAndFunded();
    state = simulateBlockedAttack(state, now + 10000);
    expect(state.payments[0]).toMatchObject({
      status: "denied",
      amount: 27900,
    });
    expect(state.walletBalance).toBe(100000);
    state = freezeAgent(state, "agt_claude");
    expect(state.agents[0]?.status).toBe("frozen");
    expect(queueFirstPayment(state, now + 11000).approvals).toHaveLength(1);
  });

  it("applies a tightened per-payment limit before queueing a request", () => {
    const state = { ...connectedAndFunded(), perPaymentMax: 25000 };
    expect(queueFirstPayment(state, now + 5000).approvals).toHaveLength(1);
    expect(state.walletBalance).toBe(100000);
  });

  it("formats displayed balances in yuan without dropping fen", () => {
    expect(formatMoney(866000)).toBe("¥8,660.00");
    expect(formatMoney(27900)).toBe("¥279.00");
  });
});
