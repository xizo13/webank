import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => await import("react-native-web"));

import { TransferControl } from "./TransferControl";

const props = {
  direction: "fund",
  amountInput: "1000.00",
  sourceBalanceFen: 866000,
  busy: false,
  onReverse: () => {},
  onAmountChange: () => {},
  onReview: () => {},
};

describe("owner transfer control", () => {
  it("names the fixed source and destination and offers a reverse action", () => {
    const html = renderToStaticMarkup(
      React.createElement(TransferControl, props),
    );
    expect(html.indexOf("WeBank main account")).toBeLessThan(
      html.indexOf("Agent Wallet"),
    );
    expect(html).toContain("Reverse transfer direction");
    expect(html).toContain('value="1000.00"');
    expect(html).toContain("Main account balance");
  });

  it("shows the wallet as source for a partial return", () => {
    const html = renderToStaticMarkup(
      React.createElement(TransferControl, {
        ...props,
        direction: "return",
        amountInput: "12.34",
        sourceBalanceFen: 27915,
      }),
    );
    expect(html.indexOf("Agent Wallet")).toBeLessThan(
      html.indexOf("WeBank main account"),
    );
    expect(html).toContain('value="12.34"');
    expect(html).toContain("Only unreserved funds can return");
  });

  it("blocks review without a confirmed balance and blocks reverse while busy", () => {
    const unavailable = renderToStaticMarkup(
      React.createElement(TransferControl, {
        ...props,
        sourceBalanceFen: null,
      }),
    );
    expect(unavailable).toContain("Main account balance: Unavailable");
    expect(
      unavailable.match(/<button[^>]*data-testid="review-funding"[^>]*>/)?.[0],
    ).toContain('aria-disabled="true"');

    const busy = renderToStaticMarkup(
      React.createElement(TransferControl, { ...props, busy: true }),
    );
    expect(
      busy.match(/<button[^>]*data-testid="reverse-transfer"[^>]*>/)?.[0],
    ).toContain('aria-disabled="true"');
    expect(
      busy.match(/<button[^>]*data-testid="review-funding"[^>]*>/)?.[0],
    ).toContain('aria-disabled="true"');
  });
});
