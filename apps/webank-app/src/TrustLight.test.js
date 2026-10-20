import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => await import("react-native-web"));

import { TrustLight } from "./TrustLight";

describe("trust light presentation", () => {
  it("renders light text, reason, and separate freeze state", () => {
    const html = renderToStaticMarkup(
      React.createElement(TrustLight, {
        light: "RED",
        reason: "Failed bank fire drill",
        frozen: true,
      }),
    );
    expect(html).toContain("RED");
    expect(html).toContain("Failed bank fire drill");
    expect(html).toContain("Separately frozen by owner");
    expect(html).toContain("RED trust light");
  });

  it("states Amber and Green behavior in accessible text", () => {
    const amber = renderToStaticMarkup(
      React.createElement(TrustLight, { light: "AMBER", reason: "New agent" }),
    );
    const green = renderToStaticMarkup(
      React.createElement(TrustLight, {
        light: "GREEN",
        reason: "Verified progress",
      }),
    );
    expect(amber).toContain("Every purchase needs your approval");
    expect(green).toContain("auto-approve threshold");
  });
});
