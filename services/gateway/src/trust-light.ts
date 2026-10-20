/** Preserves deployed LicenceRegistry ordinals. Ordinal 3 is read-only legacy. */
export function trustOrdinal(level: unknown): 1 | 2 | 4 {
  if (level === "AMBER") return 1;
  if (level === "GREEN") return 2;
  if (level === "RED") return 4;
  throw new Error("Invalid trust light");
}
