import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseEventLogs,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const require = createRequire(import.meta.url);
const solc = require('solc') as {
  compile(input: string): string;
  version(): string;
};

type CompiledContract = { abi: Abi; bytecode: Hex };

function compileContracts(): Record<'AuditAnchor' | 'CappedWallet', CompiledContract> {
  assert.match(solc.version(), /^0\.8\.11\+/, 'Use the pinned solc 0.8.11 compiler');
  const sources = {
    'AuditAnchor.sol': {
      content: readFileSync(new URL('../contracts/AuditAnchor.sol', import.meta.url), 'utf8'),
    },
    'CappedWallet.sol': {
      content: readFileSync(new URL('../contracts/CappedWallet.sol', import.meta.url), 'utf8'),
    },
  };
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      evmVersion: 'london',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: Array<{ severity: string; formattedMessage: string }>;
    contracts?: Record<string, Record<string, {
      abi: Abi;
      evm: { bytecode: { object: string } };
    }>>;
  };
  for (const diagnostic of output.errors ?? []) {
    if (diagnostic.severity === 'error') throw new Error(diagnostic.formattedMessage);
  }
  function pick(file: 'AuditAnchor.sol' | 'CappedWallet.sol', name: 'AuditAnchor' | 'CappedWallet') {
    const contract = output.contracts?.[file]?.[name];
    assert.ok(contract?.evm.bytecode.object, `Missing compiled ${name}`);
    return {
      abi: contract.abi,
      bytecode: `0x${contract.evm.bytecode.object}` as Hex,
    };
  }
  return {
    AuditAnchor: pick('AuditAnchor.sol', 'AuditAnchor'),
    CappedWallet: pick('CappedWallet.sol', 'CappedWallet'),
  };
}

const rpcUrl = process.env.FISCO_RPC_URL ?? 'http://127.0.0.1:8545';
const privateKey = process.env.FISCO_PRIVATE_KEY;
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  throw new Error('Set FISCO_PRIVATE_KEY to a funded 0x-prefixed 32-byte test key');
}
const account = privateKeyToAccount(privateKey as Hex);
const publicClient = createPublicClient({ transport: http(rpcUrl) });

async function main() {
  const chainId = await publicClient.getChainId();
  const expectedChainId = Number(process.env.FISCO_CHAIN_ID ?? '20200');
  assert.equal(chainId, expectedChainId, 'Unexpected Web3 chain ID');
  const chain = defineChain({
    id: chainId,
    name: 'FISCO BCOS local spike',
    nativeCurrency: { name: 'FISCO balance', symbol: 'FISCO', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const contracts = compileContracts();
  console.log(JSON.stringify({ rpcUrl, chainId, account: account.address, solc: solc.version() }));

  async function waitSuccess(hash: Hex, label: string, startedAt: number) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success', `${label} reverted on-chain`);
    console.log(`${label}: tx=${hash} latency_ms=${Math.round(performance.now() - startedAt)}`);
    return receipt;
  }

  async function deploy(name: 'AuditAnchor' | 'CappedWallet', args: readonly unknown[] = []) {
    const startedAt = performance.now();
    const artifact = contracts[name];
    const hash = await walletClient.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      args,
      account,
      chain,
    });
    const receipt = await waitSuccess(hash, `deploy ${name}`, startedAt);
    assert.ok(receipt.contractAddress, `${name} receipt omitted contractAddress`);
    console.log(`${name}: address=${receipt.contractAddress}`);
    return receipt.contractAddress as Address;
  }

  const auditAddress = await deploy('AuditAnchor');
  const walletAddress = await deploy('CappedWallet', [30000n]);
  const recordHash = keccak256(stringToHex('hello'));
  const orderId = keccak256(stringToHex('order-279'));

  {
    const startedAt = performance.now();
    const { request } = await publicClient.simulateContract({
      address: auditAddress,
      abi: contracts.AuditAnchor.abi,
      functionName: 'anchor',
      args: [recordHash, 1],
      account,
    });
    const hash = await walletClient.writeContract({ ...request, account, chain });
    const receipt = await waitSuccess(hash, 'anchor', startedAt);
    const events = parseEventLogs({
      abi: contracts.AuditAnchor.abi,
      logs: receipt.logs,
      eventName: 'Anchored',
    });
    assert.equal(events.length, 1, 'Expected one Anchored event');
    console.log(`Anchored: ${JSON.stringify(events[0], bigintJson)}`);
  }

  {
    const startedAt = performance.now();
    const { request } = await publicClient.simulateContract({
      address: walletAddress,
      abi: contracts.CappedWallet.abi,
      functionName: 'pay',
      args: [orderId, 27900n],
      account,
    });
    const hash = await walletClient.writeContract({ ...request, account, chain });
    const receipt = await waitSuccess(hash, 'pay 27900', startedAt);
    const events = parseEventLogs({
      abi: contracts.CappedWallet.abi,
      logs: receipt.logs,
      eventName: 'Paid',
    });
    assert.equal(events.length, 1, 'Expected one Paid event');
    console.log(`Paid: ${JSON.stringify(events[0], bigintJson)}`);
  }

  async function expectRevert(amount: bigint, expectedReason: string) {
    const startedAt = performance.now();
    try {
      await publicClient.simulateContract({
        address: walletAddress,
        abi: contracts.CappedWallet.abi,
        functionName: 'pay',
        args: [orderId, amount],
        account,
      });
    } catch (error) {
      const revert = error instanceof BaseError
        ? error.walk((cause) => cause instanceof ContractFunctionRevertedError)
        : undefined;
      const rpcError = error instanceof BaseError
        ? error.walk((cause) => cause !== null && typeof cause === 'object' && 'data' in cause && typeof cause.data === 'string' && cause.data.startsWith('0x'))
        : undefined;
      const reason = revert instanceof ContractFunctionRevertedError
        ? revert.reason
        : rpcError && 'data' in rpcError && typeof rpcError.data === 'string'
          ? decodeErrorResult({ abi: contracts.CappedWallet.abi, data: rpcError.data as Hex }).args?.[0]
          : undefined;
      assert.equal(reason, expectedReason, `No decoded ${expectedReason} revert: ${String(error)}`);
      console.log(`pay ${amount}: revert=${reason} latency_ms=${Math.round(performance.now() - startedAt)}`);
      return;
    }
    throw new Error(`pay ${amount} unexpectedly passed simulation`);
  }

  await expectRevert(50000n, 'over cap');

  {
    const startedAt = performance.now();
    const { request } = await publicClient.simulateContract({
      address: walletAddress,
      abi: contracts.CappedWallet.abi,
      functionName: 'freeze',
      account,
    });
    const hash = await walletClient.writeContract({ ...request, account, chain });
    await waitSuccess(hash, 'freeze', startedAt);
  }

  await expectRevert(100n, 'frozen');
}

function bigintJson(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
