# Local owner demo operator

Run from `product-work` after the pinned workspace dependencies and FISCO runtime are already present:

```sh
./scripts/local-demo-up.sh
```

The app is served at `http://127.0.0.1:8081` from a static Expo web export.
The simulated shop uses `127.0.0.1:3001`, the strict local-demo Gateway uses `127.0.0.1:3002`, and the four-node non-SM FISCO BCOS chain exposes Web3 RPC at `127.0.0.1:8545`.
The launcher does not open a browser or install dependencies.
It reuses the ignored merchant keys and local signers.
Read the one-time app login token from the private file path printed by the launcher.
The token and signer values are not written to launcher logs.
The app's local Gateway mode asks for that token before showing account-specific demo data.

To archive the current ignored address config and deploy a new funded wallet on the same preserved chain history, run:

```sh
./scripts/local-demo-up.sh --fresh
```

The chain operator reseeds all four simulated merchants after deployment.
The `--fresh` option does not rotate signer keys or erase chain history.
Startup does not submit a merchant payment.
Use `--fresh` before repeating a payment flow after the current demo wallet has used its daily cap.

Stop only the processes recorded by this launcher:

```sh
./scripts/local-demo-down.sh
```

Shutdown removes the ephemeral login token and PID state but preserves generated builds, private logs, keys, address archives, and chain history.
If a PID identity changes, the launcher refuses to stop that process and retains state for inspection.

## CLI evidence driver

`scripts/local-demo-e2e.mts` exercises the real local shop checkout, connector client, Gateway, FISCO test-token settlement, shop callback, and app payment-detail endpoint without an MCP host or browser.
It reads the one-time login token through `WEBANK_DEMO_LOGIN_TOKEN` and supports `success`, `security-only`, and `callback-failure` modes through `WEBANK_E2E_MODE`.
The `success` and `callback-failure` modes submit local-chain transactions, so use a fresh funded wallet for repeated runs and do not run them as a routine UI smoke.
The [verification record](../docs/verification.md) lists the observed transactions and failure behavior.

All merchants and e-CNY balances are simulated, while contract deployments and any later test payments use real transactions on the local FISCO chain.
Web approval uses an explicitly simulated proof and is not Face ID or a Secure Enclave signature.
Gateway session, mandates, and reservations are in memory.
The shop's demo controls have no authentication, so all listeners must remain bound to loopback.
This web view is for final owner acceptance only; interim automated checks should use CLI requests or an isolated VM.
