# FISCO BCOS demo contracts

The five contracts run on the local non-SM FISCO BCOS v3.17.1 chain with Web3 RPC chain ID 20200.
`ECnySim` is a simulated CNY minor-unit ledger for the prototype, not actual e-CNY.

| Contract | Responsibility |
| --- | --- |
| `ECnySim` | Bank-minted demo balance and settlement to a merchant payout address. |
| `MerchantRegistry` | Bank-curated mock merchant identity, payout address, and raw 32-byte Ed25519 public key. |
| `LicenceRegistry` | Shared record of an agent key hash and licence level. |
| `AgentWallet` | Gateway-only payments with duplicate prevention, per-payment, UTC daily and calendar-month caps, and bank freeze. |
| `AuditAnchor` | Gateway-only hash anchors, including a successful anchor transaction for a denied payment. |

The Gateway verifies merchant signatures, mandates, licence caps, user approvals, and receipt signatures before calling the chain.
The wallet contract independently enforces its hard amount caps and freeze state.
Only hashes and mock merchant metadata are stored on-chain; audit record contents stay with the signed receipt.
The bank signer controls policy changes and must be distinct from the Gateway signer.

## Compile and verify

From `product-work/`, run:

```sh
corepack pnpm install
corepack pnpm --filter @webank/onchain compile
corepack pnpm --filter @webank/onchain typecheck
corepack pnpm exec vitest run packages/chain/test/adapter.test.ts
```

The compiler is pinned to solc 0.8.11 with EVM target `london`.
It writes contract artifacts under `onchain/artifacts/` and the matching TypeScript ABI under `packages/chain/src/generated/`.
Do not edit generated files manually.

With a local chain running on `127.0.0.1:8545`, run `corepack pnpm --filter @webank/onchain smoke` for deployment, payment, denial audit, cap, freeze, and receipt checks.
The smoke test creates fresh in-memory local signers and does not write private keys.
Run `FISCO_TEST_WINDOW_ROLLOVER=1 corepack pnpm --filter @webank/onchain smoke` to test a second payment after the former false 86.4-second day boundary.
That test can take about 90 seconds because it waits for the boundary and creates a fresh FISCO block.

## Deploy

Set `FISCO_BANK_PRIVATE_KEY` to a fresh local test key and `FISCO_GATEWAY_ADDRESS` to a distinct local test signer address.
Set `FISCO_DEPLOY_OUTPUT` to an ignored local JSON path such as `scripts/chain/addresses.json` if a later script needs the addresses.
`FISCO_RPC_URL` defaults to `http://127.0.0.1:8545`.
Run `corepack pnpm --filter @webank/onchain run deploy` from `product-work/`.
The CLI validates chain ID 20200, deploys all five contracts, and mints demo funds into the agent wallet.
It prints addresses and transaction hashes without printing any signer key.
The FISCO deployment sets `AgentWallet.timestampIsMilliseconds` to true.
Solidity sees millisecond `block.timestamp` on FISCO v3.17.1 even though its Web3 RPC block response exposes seconds.
Other EVM deployments must pass false to the wallet constructor when Solidity receives seconds.

## Seed mock merchants

Set `FISCO_BANK_PRIVATE_KEY`, `FISCO_MERCHANT_REGISTRY_ADDRESS`, and `FISCO_MERCHANTS_FILE`.
The file contains a JSON array or an object with a `merchants` array.
Each entry has `merchant_id`, `payout`, `ed25519_public_key`, `legal_name`, `uscc`, `category`, and `active`.
The public key is the raw 32-byte key as `0x` hex, and the payout is a mock EVM address.
Run `corepack pnpm --filter @webank/onchain run seed:merchants`.
The CLI stores `keccak256(UTF-8 merchant_id)` as the on-chain `bytes32` ID and verifies the written public key and payout.
The text `merchant_id` remains in the signed payment request and Gateway API.

The adapter in `packages/chain` decodes FISCO's code-16 revert data, normalizes block timestamps to milliseconds, and uses the receipt-level transaction index because FISCO's log-level index is malformed.
