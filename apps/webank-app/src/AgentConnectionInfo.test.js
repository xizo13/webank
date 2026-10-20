import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => await import("react-native-web"));

import { AgentConnectionInfo } from "./AgentConnectionInfo";

const agent = {
  agent_id: "agt_one",
  display_name: "Claude personal shopper",
  client_app_id: "app_one",
  client_app_name: "Claude Code",
  idle_expires_at: "2026-10-19T07:00:00Z",
  reauthorization_required: true,
  status: "active",
  licence: { level: "AMBER", clean_purchases: 0, drills_passed: 0 },
};

function render(props = {}) {
  return renderToStaticMarkup(
    React.createElement(AgentConnectionInfo, {
      agent,
      busy: false,
      now: Date.parse("2026-10-19T08:00:00Z"),
      onReauthorize: () => {},
      ...props,
    }),
  );
}

describe("agent connection display", () => {
  it("names the client app, every-chat scope, idle deadline, and owner action", () => {
    const html = render();
    expect(html).toContain("Claude Code");
    expect(html).toContain("every chat in Claude Code");
    expect(html).toContain("Idle re-approval deadline");
    expect(html).toContain("Re-approve connection");
    expect(html).toContain('role="button"');
  });

  it("keeps spending paused after owner re-approval until the connector renews", () => {
    const html = render({ renewalExpiresAt: "2026-10-19T08:10:00Z" });
    expect(html).toContain(
      "Spending remains paused until that renewal succeeds",
    );
    expect(html).not.toContain('data-testid="reauthorize-agent-agt_one"');
  });

  it("does not offer idle re-approval to a frozen or Red agent", () => {
    const frozen = render({ agent: { ...agent, status: "frozen" } });
    const red = render({
      agent: { ...agent, licence: { ...agent.licence, level: "RED" } },
    });
    expect(frozen).not.toContain('data-testid="reauthorize-agent-agt_one"');
    expect(red).not.toContain('data-testid="reauthorize-agent-agt_one"');
  });
});
