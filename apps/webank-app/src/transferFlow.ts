import { parseYuanToFen } from "./funding";
import type { FundingChallenge } from "./gateway";

export type TransferDirection = "fund" | "return";
export type TransferState = {
  direction: TransferDirection;
  amountInput: string;
  fundingReview: { amountFen: number; challenge: FundingChallenge } | null;
  returnReviewFen: number | null;
};

export const initialTransferState: TransferState = {
  direction: "fund",
  amountInput: "1000.00",
  fundingReview: null,
  returnReviewFen: null,
};

export function transferActionsBlocked(
  fundingBusy: boolean,
  fundingInFlight: string | null,
  returnInFlight: string | null,
): boolean {
  return fundingBusy || fundingInFlight !== null || returnInFlight !== null;
}

export function fundingPreparationIsCurrent(
  state: TransferState,
  requestedAmountInput: string,
  requestVersion: number,
  currentVersion: number,
): boolean {
  return (
    state.direction === "fund" &&
    state.amountInput === requestedAmountInput &&
    requestVersion === currentVersion
  );
}

export function reverseTransfer(
  state: TransferState,
  availableWalletFen: number | null,
): TransferState {
  const direction = state.direction === "fund" ? "return" : "fund";
  return {
    direction,
    amountInput:
      direction === "return"
        ? availableWalletFen === null
          ? ""
          : (availableWalletFen / 100).toFixed(2)
        : "1000.00",
    fundingReview: null,
    returnReviewFen: null,
  };
}

export function editTransferAmount(
  state: TransferState,
  amountInput: string,
): TransferState {
  return { ...state, amountInput, fundingReview: null, returnReviewFen: null };
}

export function reviewReturnAmount(
  amountInput: string,
  availableWalletFen: number | null,
): { amountFen: number; error: null } | { amountFen: null; error: string } {
  const amountFen = parseYuanToFen(amountInput);
  if (!amountFen)
    return {
      amountFen: null,
      error: "Enter a positive CNY amount with at most two decimal places.",
    };
  if (availableWalletFen === null)
    return {
      amountFen: null,
      error:
        "A fresh confirmed available balance is required before returning funds.",
    };
  if (amountFen > availableWalletFen)
    return {
      amountFen: null,
      error: "This exceeds the unreserved Agent Wallet balance.",
    };
  return { amountFen, error: null };
}
