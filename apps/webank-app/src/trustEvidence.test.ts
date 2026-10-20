import { describe, expect, it } from "vitest";
import type { TrustEvidence } from "./gateway";
import {
  reviewableTrustEvidence,
  trustEvidenceUnchanged,
} from "./trustEvidence";

const legacy = {
  kind: "legacy_red" as const,
  reason: "Restored suspension from the earlier trust model",
  created_at: "2026-10-19T08:00:00Z",
  audit_ids: ["aud_1"],
};

const legacyReview: TrustEvidence = {
  items: [],
  legacy_evidence: [legacy],
  next_cursor: null,
};

describe("Red trust evidence gate", () => {
  it("accepts separately identified legacy evidence for owner review", () => {
    expect(reviewableTrustEvidence(legacyReview, "agt_one")).toBe(true);
    expect(trustEvidenceUnchanged(legacyReview, legacyReview, "agt_one")).toBe(
      true,
    );
  });

  it("requires another review if legacy evidence changes", () => {
    const current: TrustEvidence = {
      ...legacyReview,
      legacy_evidence: [{ ...legacy, audit_ids: ["aud_1", "aud_2"] }],
    };
    expect(trustEvidenceUnchanged(legacyReview, current, "agt_one")).toBe(
      false,
    );
  });

  it("rejects absent or incomplete evidence", () => {
    expect(
      reviewableTrustEvidence(
        { items: [], legacy_evidence: [], next_cursor: null },
        "agt_one",
      ),
    ).toBe(false);
    expect(
      reviewableTrustEvidence(
        {
          ...legacyReview,
          legacy_evidence: [{ ...legacy, reason: "" }],
        },
        "agt_one",
      ),
    ).toBe(false);
  });
});
