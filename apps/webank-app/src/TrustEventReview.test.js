import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => await import("react-native-web"));

import { TrustEventReview } from "./TrustEventReview";

describe("trust event history", () => {
  it("shows evidence and reason before owner recovery", () => {
    const html = renderToStaticMarkup(
      React.createElement(TrustEventReview, {
        events: [
          {
            event_id: "evt_red",
            agent_id: "agt_one",
            kind: "drill_failed",
            source_id: "drill_one",
            from: "AMBER",
            to: "RED",
            reason: "Agent attempted payment to registered decoy",
            occurred_at: "2026-10-19T08:00:00Z",
            audit_hash: `sha256:${"a".repeat(64)}`,
            evidence_hash: `sha256:${"b".repeat(64)}`,
          },
        ],
      }),
    );
    expect(html).toContain("Trust evidence history");
    expect(html).toContain("Agent attempted payment to registered decoy");
    expect(html).toContain("Source drill_one");
    expect(html).toContain("AMBER to RED");
    expect(html).toContain("Evidence hash:");
    expect(html).toContain(`sha256:${"b".repeat(9)}`);
    expect(html).toContain("Source event time 2026-10-19T08:00:00Z");
    expect(html).not.toContain("Confirmed light transition");
  });

  it("distinguishes source event time from confirmed light transition time", () => {
    const html = renderToStaticMarkup(
      React.createElement(TrustEventReview, {
        events: [
          {
            event_id: "evt_transition",
            agent_id: "agt_one",
            kind: "transition",
            source_id: "dispute_one",
            from: "AMBER",
            to: "RED",
            reason: "Bank confirmed disputed purchase",
            occurred_at: "2026-10-19T08:00:00Z",
            confirmed_at: "2026-10-19T08:02:00Z",
            audit_hash: `sha256:${"c".repeat(64)}`,
          },
        ],
      }),
    );
    expect(html).toContain("Source event time 2026-10-19T08:00:00Z");
    expect(html).toContain("Confirmed light transition 2026-10-19T08:02:00Z");
  });

  it("shows restored legacy Red evidence without calling it a new trust event", () => {
    const html = renderToStaticMarkup(
      React.createElement(TrustEventReview, {
        events: [],
        legacyEvidence: [
          {
            kind: "legacy_red",
            reason: "Suspended under the earlier trust model",
            created_at: "2026-10-19T08:00:00Z",
            audit_ids: ["aud_legacy"],
          },
        ],
      }),
    );
    expect(html).toContain("Legacy Red evidence");
    expect(html).toContain("restored legacy Red evidence");
    expect(html).toContain("Suspended under the earlier trust model");
    expect(html).toContain("aud_legacy");
    expect(html).toContain("no new trust event or chain audit");
  });
});
