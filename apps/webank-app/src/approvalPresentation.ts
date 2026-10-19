import type { Approval } from "./flow";
import { formatMoney } from "./flow";
import type { LivePayment, PairingConsent, PairingSummary } from "./gateway";

export function secondsRemaining(expiresAt: string, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

export function pairingCountdown(
  pairing: Pick<PairingSummary, "expires_at" | "request_number_expires_at">,
  now: number,
) {
  return {
    code: secondsRemaining(pairing.expires_at, now),
    number: pairing.request_number_expires_at
      ? secondsRemaining(pairing.request_number_expires_at, now)
      : 0,
  };
}

export function withPairingConsent(
  approvals: Approval[],
  consent: PairingConsent | null,
): Approval[] {
  if (!consent) return approvals;
  return [
    ...approvals.filter(
      (approval) => approval.approval_id !== consent.approval.approval_id,
    ),
    consent.approval,
  ];
}

const reviewReasons: Record<string, string> = {
  mandate: "The spending mandate needs your approval",
  policy_licence: "Wallet policy or the agent licence requires your review",
  risk: "Risk checks require your review",
  guardian: "An additional purchase safety check requires your review",
};

function explainReasonCodes(line: string): string {
  if (!line.startsWith("Why asking:")) return line;
  const codes = line
    .slice("Why asking:".length)
    .split(",")
    .map((code) => code.trim());
  const explanations = codes.map((code) => reviewReasons[code]).filter(Boolean);
  return explanations.length
    ? `${explanations.join(". ")}.`
    : "This request needs your review before it can continue.";
}

function shortenPublicKey(line: string): string {
  if (!line.startsWith("Public key: ")) return line;
  const key = line.slice("Public key: ".length);
  return key.length > 36
    ? `Public key preview: ${key.slice(0, 16)}…${key.slice(-10)}`
    : line;
}

function formatCnyText(line: string): string {
  return line.replace(
    /\b(\d+(?:\.\d{1,2})?) CNY\b/g,
    (_match, yuan: string) => {
      const fen = Math.round(Number(yuan) * 100);
      return Number.isSafeInteger(fen) ? formatMoney(fen) : `${yuan} CNY`;
    },
  );
}

export function presentApproval(approval: Approval, payment?: LivePayment) {
  let title = approval.title;
  if (approval.kind === "payment" && payment?.amount.currency === "CNY") {
    const marker = " wants to pay ";
    const agentName = title.includes(marker) ? title.split(marker)[0] : null;
    title = agentName
      ? `${agentName} wants to pay ${formatMoney(payment.amount.amount)}`
      : `Payment request for ${formatMoney(payment.amount.amount)}`;
  } else {
    title = formatCnyText(title);
  }
  return {
    title,
    lines: approval.lines.map((line) =>
      formatCnyText(shortenPublicKey(explainReasonCodes(line))),
    ),
  };
}
