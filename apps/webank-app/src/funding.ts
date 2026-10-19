/** Accept yuan text without floating point rounding or locale ambiguity. */
export function parseYuanToFen(value: string): number | null {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const [yuan, fraction = ""] = trimmed.split(".");
  const fen = Number(yuan) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(fen) && fen > 0 ? fen : null;
}
