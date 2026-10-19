import {
  type Address,
  createPublicClient,
  defineChain,
  type Hex,
  http,
  keccak256,
  parseEventLogs,
  stringToHex,
} from "viem";
import { expect, it } from "vitest";
import { AgentWalletAbi, connectFisco, ECnySimAbi } from "../src/index.js";

const wallet = process.env.FISCO_TEST_WALLET as Address | undefined;
const rpcUrl = process.env.FISCO_RPC_URL ?? "http://127.0.0.1:8545";

it.skipIf(!wallet)(
  "reports a fresh observation time for an idle confirmed block",
  async () => {
    if (!wallet) throw new Error("FISCO_TEST_WALLET is required");
    const chain = await connectFisco({ rpcUrl });
    const client = createPublicClient({
      chain: defineChain({
        id: 20200,
        name: "FISCO local",
        nativeCurrency: { name: "FISCO", symbol: "FISCO", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      }),
      transport: http(rpcUrl),
    });
    const [token, main] = await Promise.all([
      client.readContract({
        address: wallet,
        abi: AgentWalletAbi,
        functionName: "token",
      }),
      client.readContract({
        address: wallet,
        abi: AgentWalletAbi,
        functionName: "bank",
      }),
    ]);
    const snapshot = await chain.getWalletSnapshot(token, main, wallet);
    expect(Math.abs(Date.now() - Date.parse(snapshot.observedAt))).toBeLessThan(
      15_000,
    );
  },
);

it.skipIf(!wallet)(
  "reads one-block wallet snapshot and validates prior sweep evidence",
  async () => {
    if (!wallet) throw new Error("FISCO_TEST_WALLET is required");
    const client = createPublicClient({
      chain: defineChain({
        id: 20200,
        name: "FISCO local",
        nativeCurrency: { name: "FISCO", symbol: "FISCO", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      }),
      transport: http(rpcUrl),
    });
    const [token, main] = await Promise.all([
      client.readContract({
        address: wallet,
        abi: AgentWalletAbi,
        functionName: "token",
      }),
      client.readContract({
        address: wallet,
        abi: AgentWalletAbi,
        functionName: "bank",
      }),
    ]);
    const chain = await connectFisco({ rpcUrl });
    const snapshot = await chain.getWalletSnapshot(token, main, wallet);
    const [mainAtBlock, walletAtBlock, frozenAtBlock, block] =
      await Promise.all([
        client.readContract({
          address: token,
          abi: ECnySimAbi,
          functionName: "balanceOf",
          args: [main],
          blockNumber: snapshot.blockNumber,
        }),
        client.readContract({
          address: token,
          abi: ECnySimAbi,
          functionName: "balanceOf",
          args: [wallet],
          blockNumber: snapshot.blockNumber,
        }),
        client.readContract({
          address: wallet,
          abi: AgentWalletAbi,
          functionName: "frozen",
          blockNumber: snapshot.blockNumber,
        }),
        client.getBlock({ blockNumber: snapshot.blockNumber }),
      ]);
    expect(snapshot.mainBalance).toBe(mainAtBlock);
    expect(snapshot.walletBalance).toBe(walletAtBlock);
    expect(snapshot.walletFrozen).toBe(frozenAtBlock);
    expect(Date.parse(snapshot.observedAt)).toBeGreaterThan(1_000_000_000_000);
    expect(block.number).toBe(snapshot.blockNumber);
    await expect(
      chain.getWalletSnapshot(token, wallet, wallet),
    ).rejects.toThrow("snapshot main account");

    const sweepId = keccak256(stringToHex("smoke-sweep-one"));
    const recovered = await chain.findSweepEvidence(wallet, sweepId, 0n);
    expect(recovered?.main.toLowerCase()).toBe(main.toLowerCase());
    expect(recovered?.token.toLowerCase()).toBe(token.toLowerCase());
    expect(recovered?.amount).toBe(10_000n);
    if (!recovered) throw new Error("Expected prior smoke sweep");
    expect(
      await chain.getSweepEvidence(recovered.hash, wallet, sweepId),
    ).toEqual(recovered);
    await expect(
      chain.getSweepEvidence(
        recovered.hash,
        wallet,
        keccak256(stringToHex("wrong-sweep")),
      ),
    ).rejects.toThrow("matching Swept event");
    expect(
      await chain.findSweepEvidence(
        wallet,
        keccak256(stringToHex("unknown-sweep")),
        recovered.blockNumber,
      ),
    ).toBeUndefined();

    const fundingHash = process.env.FISCO_TEST_FUNDING_HASH as Hex | undefined;
    if (fundingHash) {
      const receipt = await client.getTransactionReceipt({ hash: fundingHash });
      const fundingEvents = parseEventLogs({
        abi: ECnySimAbi,
        logs: receipt.logs,
        eventName: "Funded",
        strict: false,
      });
      const funded = fundingEvents[0];
      if (!funded?.args.fundingId)
        throw new Error("Expected prior smoke Funded event");
      const recoveredFunding = await chain.findFundingEvidence(
        funded.address,
        funded.args.fundingId,
        0n,
      );
      expect(recoveredFunding?.hash).toBe(fundingHash);
      expect(recoveredFunding?.amount).toBe(funded.args.amount);
    }
  },
);
