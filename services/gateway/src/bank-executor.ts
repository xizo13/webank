import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ChainAddresses } from "@webank/chain";
import type { Address, Hex } from "viem";
import { isActiveFundedDeployment } from "./funded-deployment.js";

const childPath = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".js")
      ? "./bank-executor-child.js"
      : "./bank-executor-child.ts",
    import.meta.url,
  ),
);

/** The Gateway sends an already persisted intent, never a bank private key. */
export function createLocalBankExecutor(
  statePath: string,
  addresses: ChainAddresses & { bank?: Address; migration?: { state: string } },
) {
  if (!isActiveFundedDeployment(addresses) || !addresses.bank)
    throw new Error("Bank executor requires an active funding deployment");
  const submit = (
    kind: "fund" | "sweep" | "human" | "trust" | "policy",
    id: string,
    amount: bigint,
  ) =>
    new Promise<Hex>((resolve, reject) => {
      execFile(
        process.execPath,
        ["--import", "tsx", childPath, kind, id, amount.toString(), statePath],
        {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
          timeout: 120_000,
          maxBuffer: 4096,
        },
        (failure, stdout) => {
          if (failure)
            return reject(
              new Error("Bank executor did not confirm a transfer"),
            );
          try {
            const result = JSON.parse(stdout) as { tx_hash?: string };
            if (!/^0x[0-9a-fA-F]{64}$/.test(result.tx_hash ?? ""))
              throw new Error("Invalid bank executor response");
            resolve(result.tx_hash as Hex);
          } catch {
            reject(new Error("Bank executor returned invalid evidence"));
          }
        },
      );
    });
  return {
    fund: (id: string, amount: bigint) => submit("fund", id, amount),
    sweep: (id: string, amount: bigint) => submit("sweep", id, amount),
    payFromMain: (id: string, amount: bigint) => submit("human", id, amount),
    setTrustLight: (id: string, level: 1 | 2 | 4) =>
      submit("trust", id, BigInt(level)),
    setCaps: (id: string) => submit("policy", id, 1n),
  };
}
