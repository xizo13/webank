function moneyDisplay(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const money = value as Record<string, unknown>;
  if (
    typeof money.currency !== "string" ||
    !/^[A-Z]{3}$/.test(money.currency) ||
    !Number.isSafeInteger(money.amount) ||
    (money.amount as number) < 0
  )
    return undefined;
  const amount = ((money.amount as number) / 100).toFixed(2);
  return money.currency === "CNY"
    ? `¥${amount}`
    : `${money.currency} ${amount}`;
}

export function withMoneyDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withMoneyDisplay);
  if (!value || typeof value !== "object") return value;
  const fields = value as Record<string, unknown>;
  const display = moneyDisplay(fields);
  if (display) return { ...fields, display };
  const result = Object.fromEntries(
    Object.entries(fields).map(([key, item]) => [
      key,
      key === "receipt" ? item : withMoneyDisplay(item),
    ]),
  );
  const receipt = fields.receipt as Record<string, unknown> | undefined;
  const receiptDisplay = receipt && moneyDisplay(receipt.amount);
  if (receiptDisplay) result.amount_display = receiptDisplay;
  return result;
}
