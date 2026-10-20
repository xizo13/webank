# Local FISCO BCOS chain

Run these commands from the repository root on macOS arm64 or Linux x86_64.
On Windows, use Ubuntu x86_64 under WSL2 and clone into the Linux filesystem, such as `~/webank`, so owner-only file permissions work as expected.
Native Windows is not supported by this chain runner.
The Linux artifact selection and checksum checks have unit coverage; a full teammate WSL2 chain rehearsal is still pending.
The scripts use the pinned FISCO BCOS v3.17.1 non-SM Air builder and create four nodes with Web3 chain ID 20200.
The Web3 RPC is `http://127.0.0.1:8545` on node0.
All P2P and native RPC listeners also bind to `127.0.0.1`.

```sh
./scripts/chain-up.sh
./scripts/chain-down.sh
```

The first `chain-up.sh` run downloads and verifies the official binary, builder, and helper, builds the chain, creates fresh local bank and Gateway signers, starts the nodes, and deploys five demo contracts.
Later runs preserve chain state and reuse deployed addresses only while the contract source and deployment settings match their recorded fingerprint.
A changed contract source or signer now stops an ordinary restart before deployment or address rotation; use the explicit staging and migration flow while preserving Gateway state and chain history.
`chain-down.sh` stops only processes recorded by this operator.

The deployed addresses and transaction hashes are in `scripts/chain/addresses.json`.
The Gateway signer is in `scripts/chain/runtime/gateway.env`.
The bank signer is in the separate `scripts/chain/runtime/bank.env`, which should only be loaded by bank-controlled operations.
Both files are mode 0600 inside an ignored runtime directory.
Never copy either signer file into a public repository or a model prompt.

To seed all four mock merchants directly from the running shop app, use:

```sh
./scripts/chain-up.sh --merchants-url http://127.0.0.1:3001/api/merchants
```

The URL must use local HTTP on `127.0.0.1` or `localhost`.
Alternatively, save the shop response and pass `--merchants-file PATH`.
Seeding registers the raw Ed25519 public keys, mock legal names, mock USCCs, categories, and payout addresses; the shop's `honeypot` flag remains an off-chain policy signal.
The on-chain merchant ID is `keccak256(UTF-8 merchant_id)`.

For an offline first run, set `FISCO_ARCHIVE_FILE`, `FISCO_BUILDER_FILE`, `FISCO_TASSL_BINARY`, and `FISCO_ACCOUNT_HELPER_FILE` to same-platform local copies with the pinned SHA-256 values embedded in `manage.py`.
Without these variables, the same pinned official artifacts are downloaded.

After startup, run `corepack pnpm --filter @webank/onchain smoke` for a real payment, denial audit anchor, cap, freeze, registry, and receipt verification on the local chain.
The smoke test uses fresh in-memory signers and does not modify the five contract addresses in `scripts/chain/addresses.json`.
The active local demo has already completed the manual-funding cutover.
Its app starts from a simulated main-account balance and funds the Agent Wallet only after owner confirmation; the bank-signed FISCO token transfer is real on the local chain, while the app verification string and e-CNY token are demo simulations.
The separate bank executor process limits which operation the Gateway can request, but its local 0600 signer file is not protected from another process running as the same operating-system user.
For a fresh legacy deployment that still needs migration, use `./scripts/chain/manage.py stage-funding --prior-receipt-hash 0x...` with a verified historical `Paid` transaction hash from the old Agent Wallet.
The command writes `scripts/chain/runtime/funding-stage.json` only, with the new main account funded and the new Agent Wallet empty.
It does not cut over the Gateway, freeze the old wallet, or replace `scripts/chain/addresses.json`.

After staging, stop the local demo and resolve every active mandate, pending approval or pairing, and uncertain transfer.
Then run `corepack pnpm --filter @webank/gateway exec tsx src/funding-migrate.ts --cutover` from the repository root.
The command checks the exact old-wallet Paid receipt and staged zero-balance wallet, backs up owner-only state and receipt identity, freezes the old wallet with the isolated bank signer, and switches the Gateway state and active addresses.
It retains a cutover marker if interrupted; run the same command again to resume before starting the local demo.
The launcher and Gateway refuse to start while that marker exists.
Do not rerun staging or cutover against the already migrated active owner demo.
