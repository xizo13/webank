# Local FISCO BCOS chain

Run these commands from `product-work/` on macOS arm64.
The scripts use the pinned FISCO BCOS v3.17.1 non-SM Air builder and create four nodes with Web3 chain ID 20200.
The Web3 RPC is `http://127.0.0.1:8545` on node0.
All P2P and native RPC listeners also bind to `127.0.0.1`.

```sh
./scripts/chain-up.sh
./scripts/chain-down.sh
```

The first `chain-up.sh` run downloads and verifies the official binary, builder, and helper, builds the chain, creates fresh local bank and Gateway signers, starts the nodes, and deploys five demo contracts.
Later runs preserve chain state and reuse deployed addresses only while the contract source and deployment settings match their recorded fingerprint.
A changed contract source triggers a fresh set of demo contracts and a new address config while retaining the ignored local signers and chain history.
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

For an offline first run, set `FISCO_ARCHIVE_FILE`, `FISCO_BUILDER_FILE`, `FISCO_TASSL_BINARY`, and `FISCO_ACCOUNT_HELPER_FILE` to local copies with the pinned SHA-256 values embedded in `manage.py`.
Without these variables, the same pinned official artifacts are downloaded.

After startup, run `corepack pnpm --filter @webank/onchain smoke` for a real payment, denial audit anchor, cap, freeze, registry, and receipt verification on the local chain.
The smoke test uses fresh in-memory signers and does not modify the five contract addresses in `scripts/chain/addresses.json`.
