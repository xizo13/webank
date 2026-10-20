import { describe, expect, it } from "vitest";
import type { FundingChallenge } from "./gateway";
import {
  editTransferAmount,
  fundingPreparationIsCurrent,
  initialTransferState,
  reverseTransfer,
  reviewReturnAmount,
  transferActionsBlocked,
} from "./transferFlow";

const prepared = {
  ...initialTransferState,
  fundingReview: { amountFen: 100000, challenge: {} as FundingChallenge },
  returnReviewFen: 1500,
};

describe("owner transfer navigation", () => {
  it("reverses to a full available return and clears both prepared reviews", () => {
    const returning = reverseTransfer(prepared, 27915);
    expect(returning).toEqual({
      direction: "return",
      amountInput: "279.15",
      fundingReview: null,
      returnReviewFen: null,
    });
    expect(reverseTransfer(returning, 27915)).toEqual(initialTransferState);
  });

  it("keeps return review unavailable when a fresh balance is missing", () => {
    expect(reverseTransfer(prepared, null).amountInput).toBe("");
    expect(reviewReturnAmount("12.34", null)).toMatchObject({
      amountFen: null,
      error: expect.stringContaining("fresh confirmed"),
    });
  });

  it("reviews an exact partial return in integer fen and rejects excess or fractional fen", () => {
    expect(reviewReturnAmount("12.34", 27915)).toEqual({
      amountFen: 1234,
      error: null,
    });
    expect(reviewReturnAmount("279.16", 27915)).toMatchObject({
      amountFen: null,
      error: expect.stringContaining("exceeds"),
    });
    expect(reviewReturnAmount("12.345", 27915)).toMatchObject({
      amountFen: null,
      error: expect.stringContaining("two decimal places"),
    });
    expect(editTransferAmount(prepared, "12.34")).toMatchObject({
      amountInput: "12.34",
      fundingReview: null,
      returnReviewFen: null,
    });
  });

  it("blocks both directions while either transfer outcome is uncertain", () => {
    expect(transferActionsBlocked(false, null, null)).toBe(false);
    expect(transferActionsBlocked(true, null, null)).toBe(true);
    expect(transferActionsBlocked(false, "funding-id", null)).toBe(true);
    expect(transferActionsBlocked(false, null, "unknown")).toBe(true);
  });

  it("rejects a delayed funding challenge after any amount edit or reversal", () => {
    expect(
      fundingPreparationIsCurrent(initialTransferState, "1000.00", 0, 0),
    ).toBe(true);
    expect(
      fundingPreparationIsCurrent(
        editTransferAmount(initialTransferState, "25.00"),
        "1000.00",
        0,
        1,
      ),
    ).toBe(false);
    expect(
      fundingPreparationIsCurrent(initialTransferState, "1000.00", 0, 2),
    ).toBe(false);
    expect(
      fundingPreparationIsCurrent(
        reverseTransfer(initialTransferState, 5000),
        "1000.00",
        0,
        1,
      ),
    ).toBe(false);
  });
});
