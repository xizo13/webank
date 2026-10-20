/** Classify only completed local funded deployments; partial manifests fail closed. */
const NATIVE_FUNDED_TRANSACTIONS = [
  "configureAgentWallet",
  "deployAgentWallet",
  "deployAuditAnchor",
  "deployECnySim",
  "deployLicenceRegistry",
  "deployMerchantRegistry",
  "openingMint",
] as const;

type FundingManifest = {
  bank?: unknown;
  migration?: unknown;
  chainId?: unknown;
  rpcUrl?: unknown;
  deploymentFingerprint?: unknown;
  txHashes?: unknown;
};

export function isActiveFundedDeployment(addresses: FundingManifest): boolean {
  const bankValid =
    typeof addresses.bank === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(addresses.bank);
  if (addresses.migration !== undefined) {
    if (
      !addresses.migration ||
      typeof addresses.migration !== "object" ||
      (addresses.migration as { state?: unknown }).state !== "active" ||
      !bankValid
    )
      throw new Error("Funding migration is not active");
    return true;
  }
  const nativeMarked =
    addresses.bank !== undefined ||
    addresses.txHashes !== undefined ||
    addresses.deploymentFingerprint !== undefined;
  if (!nativeMarked) return false;
  const hashes = addresses.txHashes;
  if (
    !bankValid ||
    addresses.chainId !== 20200 ||
    addresses.rpcUrl !== "http://127.0.0.1:8545" ||
    typeof addresses.deploymentFingerprint !== "string" ||
    !/^[0-9a-fA-F]{64}$/.test(addresses.deploymentFingerprint) ||
    !hashes ||
    typeof hashes !== "object" ||
    Array.isArray(hashes)
  )
    throw new Error("Native funded deployment manifest is incomplete");
  const entries = Object.entries(hashes);
  if (
    entries.length !== NATIVE_FUNDED_TRANSACTIONS.length ||
    entries.some(
      ([name, hash]) =>
        !NATIVE_FUNDED_TRANSACTIONS.includes(
          name as (typeof NATIVE_FUNDED_TRANSACTIONS)[number],
        ) ||
        typeof hash !== "string" ||
        !/^0x[0-9a-fA-F]{64}$/.test(hash),
    ) ||
    new Set(entries.map(([, hash]) => hash)).size !== entries.length
  )
    throw new Error("Native funded deployment evidence is incomplete");
  return true;
}
