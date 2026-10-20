import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => await import("react-native-web"));

import { PairingClientScope } from "./PairingClientScope";

describe("pairing client scope", () => {
  it("names the client app and the every-chat grant", () => {
    const html = renderToStaticMarkup(
      React.createElement(PairingClientScope, {
        clientAppName: "Claude Code",
        publicKey: "p256:registered-public-key",
      }),
    );
    expect(html).toContain("Client app");
    expect(html).toContain("Claude Code");
    expect(html).toContain("This connection covers every chat in Claude Code.");
    expect(html).toContain("Agent key: p256:registered-public");
  });

  it("warns when a client app identity is missing", () => {
    const html = renderToStaticMarkup(
      React.createElement(PairingClientScope, {
        clientAppName: null,
        publicKey: "p256:registered-public-key",
      }),
    );
    expect(html).toContain("cannot be approved without a client app identity");
  });
});
