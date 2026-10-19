import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgentWalletAbi,
  ChainRevertError,
  connectFisco,
  decodeChainRevert,
  ECnySimAbi,
} from "@webank/chain";
import {
  createPublicClient,
  defineChain,
  type Hex,
  http,
  keccak256,
  stringToHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { deployAll } from "../scripts/deploy.js";
import { stageFundingMigration } from "../scripts/stage-funding.js";

const rpcUrl = process.env.FISCO_RPC_URL ?? "http://127.0.0.1:8545";
const bankPrivateKey = generatePrivateKey();
const gatewayPrivateKey = generatePrivateKey();
const merchantPrivateKey = generatePrivateKey();
const gateway = privateKeyToAccount(gatewayPrivateKey).address;
const merchantPayout = privateKeyToAccount(merchantPrivateKey).address;
const merchantId = keccak256(stringToHex("smoke-merchant"));
const firstPaymentId = keccak256(stringToHex("smoke-payment-one"));
const secondPaymentId = keccak256(stringToHex("smoke-payment-two"));
const denialHash = keccak256(stringToHex("smoke-denial-record"));
const denialId = keccak256(stringToHex("smoke-denial"));
const agentId = keccak256(stringToHex("smoke-agent"));
const agentKeyHash = keccak256(stringToHex("smoke-agent-key"));
const signingKey = keccak256(stringToHex("demo-public-key"));
const fundingId = keccak256(stringToHex("smoke-funding-one"));
const secondFundingId = keccak256(stringToHex("smoke-funding-two"));
const sweepId = keccak256(stringToHex("smoke-sweep-one"));
const publicClient = createPublicClient({
  chain: defineChain({
    id: 20200,
    name: "FISCO local",
    nativeCurrency: { name: "FISCO balance", symbol: "FISCO", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }),
  transport: http(rpcUrl),
});

const deployment = await deployAll({
  bankPrivateKey,
  gateway,
  rpcUrl,
  perPaymentCap: 30_000n,
  dailyCap: 50_000n,
  monthlyCap: 100_000n,
  mainOpeningBalance: 100_000n,
  merchant: {
    id: merchantId,
    payout: merchantPayout,
    signingKey,
    legalName: "Smoke Shop (mock)",
    uscc: "MOCK-ONLY",
    category: "electronics",
  },
});
const chain = await connectFisco({ rpcUrl, privateKey: gatewayPrivateKey });
const bankChain = await connectFisco({ rpcUrl, privateKey: bankPrivateKey });
const readonlyChain = await connectFisco({ rpcUrl });
assert.equal(
  await readonlyChain.getTokenBalance(
    deployment.ecnySim,
    deployment.agentWallet,
  ),
  0n,
);
assert.equal(
  await readonlyChain.getTokenBalance(deployment.ecnySim, deployment.bank),
  100_000n,
);
const fundingHash = await bankChain.fundAgentWallet(
  deployment.ecnySim,
  fundingId,
  100_000n,
);
const fundingEvidence = await readonlyChain.getFundingEvidence(
  fundingHash,
  deployment.ecnySim,
  fundingId,
);
assert.equal(fundingEvidence.main.toLowerCase(), deployment.bank.toLowerCase());
assert.equal(
  fundingEvidence.wallet.toLowerCase(),
  deployment.agentWallet.toLowerCase(),
);
assert.equal(fundingEvidence.amount, 100_000n);
const recoveredFunding = await readonlyChain.findFundingEvidence(
  deployment.ecnySim,
  fundingId,
  fundingEvidence.blockNumber,
);
assert.equal(recoveredFunding?.hash, fundingHash);
assert.equal(
  await readonlyChain.getTokenBalance(deployment.ecnySim, deployment.bank),
  0n,
);
assert.equal(
  await readonlyChain.getTokenBalance(
    deployment.ecnySim,
    deployment.agentWallet,
  ),
  100_000n,
);
assert.equal(
  await readonlyChain.isFundingApplied(deployment.ecnySim, fundingId),
  true,
);
const registryRecord = await readonlyChain.getMerchant(
  deployment.merchantRegistry,
  merchantId,
);
assert.equal(registryRecord.payout.toLowerCase(), merchantPayout.toLowerCase());
assert.equal(registryRecord.active, true);
assert.equal(registryRecord.signingKey, signingKey);
await bankChain.setLicence(
  deployment.licenceRegistry,
  agentId,
  agentKeyHash,
  1,
);
const licence = await readonlyChain.getLicence(
  deployment.licenceRegistry,
  agentId,
);
assert.equal(licence.keyHash, agentKeyHash);
assert.equal(licence.level, 1);

const paymentHash = await chain.pay(
  deployment.agentWallet,
  firstPaymentId,
  merchantId,
  27_900n,
);
const paymentEvidence = await readonlyChain.getTransactionEvidence(paymentHash);
assert.equal(paymentEvidence.status, "success");
assert.equal(paymentEvidence.paidEvents.length, 1);
assert.equal(paymentEvidence.paidEvents[0]?.amount, 27_900n);
assert.equal(paymentEvidence.paidEvents[0]?.merchantId, merchantId);
assert.ok(paymentEvidence.blockTimestampMs > 1_000_000_000_000);
const paymentBlock = await publicClient.getBlock({
  blockNumber: paymentEvidence.blockNumber,
});
const expectedDay = BigInt(
  Math.floor(paymentEvidence.blockTimestampMs / 86_400_000),
);
const paymentDate = new Date(paymentEvidence.blockTimestampMs);
const expectedMonth = BigInt(
  paymentDate.getUTCFullYear() * 12 + paymentDate.getUTCMonth(),
);
const spentInUtcDay = await publicClient.readContract({
  address: deployment.agentWallet,
  abi: AgentWalletAbi,
  functionName: "spentByDay",
  args: [expectedDay],
});
const spentInRawDay = await publicClient.readContract({
  address: deployment.agentWallet,
  abi: AgentWalletAbi,
  functionName: "spentByDay",
  args: [paymentBlock.timestamp / 86_400n],
});
const spentInMillisecondDay = await publicClient.readContract({
  address: deployment.agentWallet,
  abi: AgentWalletAbi,
  functionName: "spentByDay",
  args: [BigInt(paymentEvidence.blockTimestampMs) / 86_400n],
});
const spentInUtcMonth = await publicClient.readContract({
  address: deployment.agentWallet,
  abi: AgentWalletAbi,
  functionName: "spentByMonth",
  args: [expectedMonth],
});
const nativeTimestamp = await publicClient.readContract({
  address: deployment.agentWallet,
  abi: AgentWalletAbi,
  functionName: "currentTimestamp",
});
const nativeDay = await publicClient.readContract({
  address: deployment.agentWallet,
  abi: AgentWalletAbi,
  functionName: "currentDayIndex",
});
const nativeMonth = await publicClient.readContract({
  address: deployment.agentWallet,
  abi: AgentWalletAbi,
  functionName: "currentMonthIndex",
});
const timestampIsMilliseconds = await publicClient.readContract({
  address: deployment.agentWallet,
  abi: AgentWalletAbi,
  functionName: "timestampIsMilliseconds",
});
console.log(
  JSON.stringify({
    timestampProof: {
      rawBlockTimestamp: paymentBlock.timestamp.toString(),
      nativeTimestamp: nativeTimestamp.toString(),
      timestampIsMilliseconds,
      expectedUtcDay: expectedDay.toString(),
      storedAtUtcDay: spentInUtcDay.toString(),
      storedAtRawDay: spentInRawDay.toString(),
      storedAtMillisecondDay: spentInMillisecondDay.toString(),
      expectedUtcMonth: expectedMonth.toString(),
      storedAtUtcMonth: spentInUtcMonth.toString(),
      currentDay: nativeDay.toString(),
      currentMonth: nativeMonth.toString(),
    },
  }),
);
assert.ok(
  nativeTimestamp >= 1_000_000_000_000n,
  "FISCO Solidity timestamp is milliseconds",
);
assert.equal(timestampIsMilliseconds, true);
assert.equal(nativeDay, expectedDay);
assert.equal(nativeMonth, expectedMonth);
assert.equal(spentInUtcDay, 27_900n, "payment must count in the real UTC day");
assert.equal(
  spentInUtcMonth,
  27_900n,
  "payment must count in the real UTC month",
);

async function expectReason(operation: () => Promise<Hex>, reason: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(
      error instanceof ChainRevertError,
      `Expected decoded revert, got ${String(error)}`,
    );
    assert.equal(error.reason, reason);
    return true;
  });
}

await expectReason(
  () => bankChain.fundAgentWallet(deployment.ecnySim, fundingId, 1n),
  "already funded",
);
await expectReason(
  () => bankChain.fundAgentWallet(deployment.ecnySim, secondFundingId, 0n),
  "zero amount",
);
await expectReason(
  () => bankChain.fundAgentWallet(deployment.ecnySim, secondFundingId, 1n),
  "insufficient main",
);
await expectReason(
  () => chain.fundAgentWallet(deployment.ecnySim, secondFundingId, 1n),
  "not bank",
);
await assert.rejects(
  publicClient.simulateContract({
    address: deployment.ecnySim,
    abi: ECnySimAbi,
    functionName: "transfer",
    args: [deployment.agentWallet, 1n],
    account: deployment.bank,
  }),
  (error: unknown) => decodeChainRevert(error, ECnySimAbi) === "funding only",
);
assert.equal(
  await readonlyChain.isFundingApplied(deployment.ecnySim, secondFundingId),
  false,
);

await expectReason(
  () => chain.pay(deployment.agentWallet, firstPaymentId, merchantId, 100n),
  "already paid",
);
await expectReason(
  () => chain.pay(deployment.agentWallet, secondPaymentId, merchantId, 50_000n),
  "over payment cap",
);
await expectReason(
  () => chain.pay(deployment.agentWallet, secondPaymentId, merchantId, 23_000n),
  "over daily cap",
);
let crossedFalseDayBoundary = false;
if (process.env.FISCO_TEST_WINDOW_ROLLOVER === "1") {
  const falseDayAtPayment = nativeTimestamp / 86_400n;
  const nextFalseBoundary = (falseDayAtPayment + 1n) * 86_400n;
  await delay(Math.max(0, Number(nextFalseBoundary - nativeTimestamp) + 1000));
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    // FISCO only commits a fresh timestamp when a transaction creates a block.
    await bankChain.setCaps(deployment.agentWallet, 30_000n, 50_000n, 100_000n);
    const now = await publicClient.readContract({
      address: deployment.agentWallet,
      abi: AgentWalletAbi,
      functionName: "currentTimestamp",
    });
    if (now / 86_400n > falseDayAtPayment) {
      crossedFalseDayBoundary = true;
      break;
    }
    await delay(1000);
  }
  assert.ok(
    crossedFalseDayBoundary,
    "FISCO millisecond timestamp crossed the old 86.4-second bucket",
  );
  const sameUtcDay = await publicClient.readContract({
    address: deployment.agentWallet,
    abi: AgentWalletAbi,
    functionName: "currentDayIndex",
  });
  assert.equal(
    sameUtcDay,
    expectedDay,
    "rollover test must stay in one UTC day",
  );
  await expectReason(
    () =>
      chain.pay(deployment.agentWallet, secondPaymentId, merchantId, 23_000n),
    "over daily cap",
  );
}
await expectReason(
  () =>
    bankChain.pay(deployment.agentWallet, secondPaymentId, merchantId, 100n),
  "not gateway",
);
await expectReason(
  () => chain.setLicence(deployment.licenceRegistry, agentId, agentKeyHash, 2),
  "not bank",
);
await expectReason(
  () => chain.setCaps(deployment.agentWallet, 20_000n, 50_000n, 100_000n),
  "not bank",
);
await bankChain.setCaps(deployment.agentWallet, 20_000n, 50_000n, 100_000n);
await expectReason(
  () => chain.pay(deployment.agentWallet, secondPaymentId, merchantId, 21_000n),
  "over payment cap",
);

const auditHash = await chain.anchor(
  deployment.auditAnchor,
  denialHash,
  denialId,
  3,
);
const auditEvidence = await readonlyChain.getTransactionEvidence(auditHash);
assert.equal(auditEvidence.anchoredEvents.length, 1);
assert.equal(auditEvidence.anchoredEvents[0]?.recordHash, denialHash);
await expectReason(
  () => chain.anchor(deployment.auditAnchor, denialHash, denialId, 3),
  "already anchored",
);

await bankChain.setFrozen(deployment.agentWallet, true);
await expectReason(
  () => chain.pay(deployment.agentWallet, secondPaymentId, merchantId, 1n),
  "frozen",
);
const sweepHash = await bankChain.sweepToMain(
  deployment.agentWallet,
  sweepId,
  10_000n,
);
const sweepEvidence = await readonlyChain.getTransactionEvidence(sweepHash);
assert.equal(sweepEvidence.sweptEvents.length, 1);
assert.equal(sweepEvidence.sweptEvents[0]?.amount, 10_000n);
assert.equal(
  sweepEvidence.sweptEvents[0]?.main.toLowerCase(),
  deployment.bank.toLowerCase(),
);
assert.equal(
  await readonlyChain.getTokenBalance(deployment.ecnySim, deployment.bank),
  10_000n,
);
await expectReason(
  () => bankChain.sweepToMain(deployment.agentWallet, sweepId, 1n),
  "already swept",
);
await expectReason(
  () =>
    chain.sweepToMain(
      deployment.agentWallet,
      keccak256(stringToHex("unauthorized-sweep")),
      1n,
    ),
  "not bank",
);

const merchantBalance = await publicClient.readContract({
  address: deployment.ecnySim,
  abi: ECnySimAbi,
  functionName: "balanceOf",
  args: [merchantPayout],
});
assert.equal(merchantBalance, 27_900n);

const priorEvidence = await readonlyChain.getTransactionEvidence(paymentHash);
await assert.rejects(
  stageFundingMigration({
    bankPrivateKey,
    old: { ...deployment, deploymentFingerprint: "isolated-rehearsal" },
    rpcUrl,
    priorReceiptHash: sweepHash,
  }),
  /Prior receipt is not a Paid event from old wallet/,
);
const staged = await stageFundingMigration({
  bankPrivateKey,
  old: { ...deployment, deploymentFingerprint: "isolated-rehearsal" },
  rpcUrl,
  priorReceiptHash: paymentHash,
});
const preservedEvidence =
  await readonlyChain.getTransactionEvidence(paymentHash);
assert.deepEqual(preservedEvidence.paidEvents, priorEvidence.paidEvents);
assert.equal(preservedEvidence.status, "success");
assert.notEqual(
  staged.agentWallet.toLowerCase(),
  deployment.agentWallet.toLowerCase(),
);
assert.notEqual(staged.ecnySim.toLowerCase(), deployment.ecnySim.toLowerCase());
assert.equal(
  staged.merchantRegistry.toLowerCase(),
  deployment.merchantRegistry.toLowerCase(),
);
assert.equal(
  staged.auditAnchor.toLowerCase(),
  deployment.auditAnchor.toLowerCase(),
);
assert.equal(
  await readonlyChain.getTokenBalance(staged.ecnySim, staged.agentWallet),
  0n,
);
assert.equal(
  await readonlyChain.getTokenBalance(staged.ecnySim, staged.bank),
  866_000n,
);
assert.equal(
  await readonlyChain.getTokenBalance(deployment.ecnySim, merchantPayout),
  27_900n,
);

async function indexFor(
  functionName: "dayIndexFor" | "monthIndexFor",
  timestamp: number,
  milliseconds: boolean,
) {
  return publicClient.readContract({
    address: deployment.agentWallet,
    abi: AgentWalletAbi,
    functionName,
    args: [BigInt(timestamp), milliseconds],
  });
}

const dayStartMs = Date.UTC(2026, 1, 1);
const monthStartMs = Date.UTC(2026, 2, 1);
for (const milliseconds of [false, true]) {
  const scale = milliseconds ? 1 : 1000;
  const unit = milliseconds ? 1 : 1000;
  const beforeDay = await indexFor(
    "dayIndexFor",
    (dayStartMs - unit) / scale,
    milliseconds,
  );
  const atDay = await indexFor("dayIndexFor", dayStartMs / scale, milliseconds);
  assert.equal(atDay, beforeDay + 1n, "UTC day changes at midnight");
  const beforeMonth = await indexFor(
    "monthIndexFor",
    (monthStartMs - unit) / scale,
    milliseconds,
  );
  const atMonth = await indexFor(
    "monthIndexFor",
    monthStartMs / scale,
    milliseconds,
  );
  assert.equal(
    atMonth,
    beforeMonth + 1n,
    "UTC calendar month changes at midnight",
  );
  const withinDay = await indexFor(
    "dayIndexFor",
    (dayStartMs + 86_400_000) / scale,
    milliseconds,
  );
  assert.equal(
    withinDay,
    atDay + 1n,
    "day index is independent of timestamp unit",
  );
  const earlyResetA = await indexFor(
    "dayIndexFor",
    (dayStartMs + 1000) / scale,
    milliseconds,
  );
  const earlyResetB = await indexFor(
    "dayIndexFor",
    (dayStartMs + 87_000) / scale,
    milliseconds,
  );
  assert.equal(
    earlyResetA,
    earlyResetB,
    "day cap cannot reset after 86.4 seconds",
  );
  const monthEarlyA = await indexFor(
    "monthIndexFor",
    (dayStartMs + 1000) / scale,
    milliseconds,
  );
  const monthEarlyB = await indexFor(
    "monthIndexFor",
    (dayStartMs + 2_592_000) / scale,
    milliseconds,
  );
  assert.equal(
    monthEarlyA,
    monthEarlyB,
    "month cap cannot reset after a false 43.2-minute bucket",
  );
}

const january = await publicClient.readContract({
  address: deployment.agentWallet,
  abi: AgentWalletAbi,
  functionName: "monthIndex",
  args: [BigInt(Date.UTC(2026, 0, 31) / 1000)],
});
const february = await publicClient.readContract({
  address: deployment.agentWallet,
  abi: AgentWalletAbi,
  functionName: "monthIndex",
  args: [BigInt(Date.UTC(2026, 1, 1) / 1000)],
});
assert.equal(february, january + 1n);

console.log(
  JSON.stringify(
    {
      chainId: deployment.chainId,
      contracts: {
        wallet: deployment.agentWallet,
        merchantRegistry: deployment.merchantRegistry,
        auditAnchor: deployment.auditAnchor,
      },
      paymentTx: paymentHash,
      denialAuditTx: auditHash,
      paidAmount: merchantBalance.toString(),
      fundingTx: fundingHash,
      checks: [
        "main opening balance and empty wallet",
        "bank-only one-time funding with verified Funded event",
        "funding recovery by ID from starting block",
        "duplicate, zero, and insufficient-main funding rejection",
        "direct wallet deposit blocked outside funding ID",
        "merchant registry",
        "licence registry",
        "payment receipt and event",
        "duplicate payment",
        "per-payment cap",
        "daily cap",
        "gateway authorization",
        "bank-only licence and cap changes",
        "bank cap tightening",
        "denial audit anchor",
        "duplicate anchor",
        "freeze",
        "bank-only one-time sweep back to main with receipt evidence",
        "ledger settlement",
        "isolated same-chain staged migration preserves prior Paid receipt and registry",
        "calendar month boundary",
        "millisecond and second day boundary",
        "millisecond and second calendar month boundary",
        "no early day or month key reset",
        "native FISCO timestamp and live UTC cap keys",
        ...(crossedFalseDayBoundary
          ? ["daily cap across former 86.4-second rollover"]
          : []),
      ],
    },
    null,
    2,
  ),
);
