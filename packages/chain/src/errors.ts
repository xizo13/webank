import {
  type Abi,
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  type Hex,
} from "viem";

export class ChainRevertError extends Error {
  constructor(
    public readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Chain transaction rejected: ${reason}`, options);
    this.name = "ChainRevertError";
  }
}

/** FISCO Web3 RPC v3.17.1 returns Error(string) bytes in a code-16 error. */
export function decodeChainRevert(
  error: unknown,
  abi: Abi,
): string | undefined {
  if (error instanceof BaseError) {
    const reverted = error.walk(
      (cause) => cause instanceof ContractFunctionRevertedError,
    );
    if (reverted instanceof ContractFunctionRevertedError && reverted.reason)
      return reverted.reason;
  }
  const data = findRevertData(error);
  if (!data) return undefined;
  try {
    const decoded = decodeErrorResult({ abi, data });
    if (
      decoded.errorName === "Error" &&
      typeof decoded.args?.[0] === "string"
    ) {
      return decoded.args[0];
    }
    return decoded.errorName;
  } catch {
    return undefined;
  }
}

export function normalizeChainError(error: unknown, abi: Abi): Error {
  const reason = decodeChainRevert(error, abi);
  if (reason) return new ChainRevertError(reason, { cause: error });
  return error instanceof Error ? error : new Error(String(error));
}

function findRevertData(error: unknown): Hex | undefined {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { data?: unknown; cause?: unknown };
    if (
      typeof record.data === "string" &&
      /^0x[0-9a-fA-F]{8,}$/.test(record.data)
    ) {
      return record.data as Hex;
    }
    current = record.cause;
  }
  return undefined;
}
