# Local owner demo operator

Run from the repository root after the pinned workspace dependencies and FISCO runtime are already present:

```sh
./scripts/local-demo-up.sh
```

The app is served at `http://127.0.0.1:8081` from a static Expo web export.
The simulated shop uses `127.0.0.1:3001`, the strict local-demo Gateway uses `127.0.0.1:3002`, and the four-node non-SM FISCO BCOS chain exposes Web3 RPC at `127.0.0.1:8545`.
The read-only Bank Console is at `http://127.0.0.1:3002/demo/console` and accepts only local loopback requests.
The launcher does not open a browser or install dependencies.
It selects an installed Node 22 binary and puts that binary's directory first on PATH for child services, Corepack, and the chain seed process.
Set `WEBANK_NODE_BINARY` to a specific executable Node 22 path when the automatic search cannot find one.
It reuses the ignored merchant keys and local signers.
Read the private app bootstrap login token from the file path printed by the launcher, `scripts/local-demo-runtime/app-login-token`.
That file has mode `0600`; read it locally as the owner and do not paste its value into chat or logs.
The token and signer values are not written to launcher logs.
The app's local Gateway mode asks for that token before showing account-specific demo data.
The login token is reusable during the current Gateway identity, survives an ordinary restart even though shutdown removes its temporary file, and rotates after a fresh reset archives that identity.

## Optional Guardian review

The Gateway can call a dedicated local Nous Research Hermes Agent profile for one fixed intent review per payment.
Set the Hermes URL, key, and operator verification flag only in local uncommitted configuration after checking that the profile has no callable tools, MCP servers, plugins, memory, or skills.
The [Guardian guide](../services/guardian/README.md) lists the exact environment names and isolation checks.
Without verified configuration, Guardian fails closed to owner review.
The deterministic tests cover this transport, and the dedicated zero-tool profile passed a live synthetic smoke test.
The signed local shop-to-app acceptance run later showed one Amber owner card, a Green ¥77.00 FISCO payment without a card, and a contradictory signed order denied by Hermes without a wallet debit.

Before a fresh reset, stop the launcher and inspect free disk space from the repository root:

```sh
./scripts/local-demo-down.sh
df -h .
```

The launcher requires at least 1 GiB free and builds locally, so leave additional room above that minimum for chain data and build output.
For the recording setup, run `./scripts/local-demo-stage.sh` first to see a read-only staging status.
After resolving active financial work, run `./scripts/local-demo-stage.sh --execute` to stop the launcher-owned demo, archive the old owner and shop state, deploy new contracts on the same FISCO chain, and verify the recording baseline.
The staging command checks that the Agent Wallet service is off, its new contract balance and UTC day and month spending are zero, there are no new agents or pairings, the bank fire drill is off, and the protected shop reset has restored ordinary prices and controls.
It stops the newly started services if those checks fail; inspect the preserved archive and logs before retrying.
Resolve pending pairings, approvals, mandates, payments, funding, sweeps, human payments, and any historical agent replacement fence before resetting; the launcher refuses to archive unresolved Gateway financial state.
An expired pairing may still be stored as `pending`; the reset accepts it only after its verified deadline has passed.
To archive the current local demo state and deploy a new funded wallet on the same preserved chain history, run:

```sh
./scripts/local-demo-up.sh --fresh
```

The chain operator reseeds all four simulated merchants after deployment and verifies the native deployment, opening mint, and wallet configuration receipts.
The new deployment mints 866,000 fen to the simulated main account and starts its Agent Wallet at zero.
In a fresh funded local demo, the Agent Wallet starts disabled; the signed-in owner must review and simulate its one-time enable action in the app before pairing, funding, mandates, or payment requests.
Fund the Agent Wallet through the app's visibly simulated owner approval before creating a mandate or running a payment flow.
The `--fresh` option preserves signer keys, merchant keys, the connector's local credential, and FISCO chain history.
It archives the prior private Gateway state and receipt signing identity, address manifest, and shop state under `scripts/local-demo-runtime/fresh-reset-archives/<timestamp-random>/`.
The archive is owner-only, and the shop starts with a new cart and order state while retaining its registered merchant keys.
An ordinary restart keeps the deployment, Gateway state, shop state, and identity in place and refuses to load them against a different chain deployment.
Startup does not submit a merchant payment.
After `--fresh`, call `connect_webank({ re_pair: true })` in the MCP host to replace the old local connector pairing, then approve the new pairing in the app.
The launcher does not delete or silently rotate the connector credential.
The recording stage generates a separate owner-only shop operator token at `scripts/local-demo-runtime/shop-operator-token` and uses it only over loopback for the protected shop reset.
The token never appears in the URL or logs.
The connector cannot unfreeze an agent or restore a prior licence.

The fresh reset takes an exclusive Gateway writer lock while it validates and archives private state.
If a prior crash leaves a stale Gateway lock, verify that its recorded PID has exited and follow the exact recovery procedure in the [Gateway guide](../services/gateway/README.md); never remove a live writer lock.
The private `scripts/local-demo-runtime/fresh-reset.json` journal tracks an incomplete fresh reset and is removed only after all services start successfully.
If `--fresh` fails after archiving or deployment, stop any launcher-owned processes if a launcher state exists, inspect the private journal and logs, and retry the same command:

```sh
./scripts/local-demo-down.sh
./scripts/local-demo-up.sh --fresh
```

Do not manually delete the reset journal, pending deployment manifest, or archive.
The retry resumes the verified archive and deployment path while preserving chain history.

Stop only the processes recorded by this launcher:

```sh
./scripts/local-demo-down.sh
```

Shutdown removes the temporary login token file and PID state but preserves the reusable Gateway login identity, durable Gateway and shop state, generated builds, private logs, keys, address archives, and chain history.
If a PID identity changes, the launcher refuses to stop that process and retains state for inspection.

## Lost-hash human payment recovery

An interrupted main-account QR payment can remain `reconciliation_required` without a transaction hash even if the bank child broadcast a token transfer.
Do not retry that payment with a new scan or edit the Gateway state by hand.
Stop the Gateway with `./scripts/local-demo-down.sh`, verify that no bank child or external main-account writer remains active, then inspect the held confirmation ID from the repository root:

```sh
corepack pnpm --filter @webank/gateway exec tsx src/reconcile-human-payment.ts inspect hpm_<id>
```

The read-only inspection searches the active token's `Transfer` events in ten-block pages from the durable pre-submit block and prints matching main-account sender, registered payout, and exact amount candidates.
Inspect the shop order, bank executor logs, chain receipt, and any other main-account activity to establish that one candidate belongs to this exact order.
The generic token event carries no order ID, so the on-chain match alone cannot prove attribution.
If there are zero or multiple candidates, a competing intent, or any doubt about an external writer, keep the payment held and investigate manually.
Only when one candidate and independent order proof agree, attach its hash while the Gateway is stopped:

```sh
corepack pnpm --filter @webank/gateway exec tsx src/reconcile-human-payment.ts attach hpm_<id> 0x<transaction-hash> --attest-sole-bank-writer --attest-order-attribution
```

Both attestations are operator claims; this command does not submit a transfer or mark the payment completed.
Restart the existing deployment with `./scripts/local-demo-up.sh`, then refresh the payment status in the app so the Gateway verifies the receipt and notifies the shop.
Preserve the state, logs, and chain history if that verification remains uncertain.

## CLI evidence driver

`scripts/local-demo-e2e.mts` exercises the real local shop checkout, connector client, Gateway, FISCO test-token settlement, shop callback, and app payment-detail endpoint without an MCP host or browser.
It reads the private bootstrap login token through `WEBANK_DEMO_LOGIN_TOKEN` and accepts `success`, `security-only`, and `callback-failure` values through `WEBANK_E2E_MODE`.
In success mode, it also reads the mode-`0600` `shop-operator-token` file to reset shop data through the protected loopback operator route after the Gateway fire drill stops.
The driver does not fund a zero-balance Agent Wallet, so fund it in the app before any mode that creates a mandate.
The `success` mode resets shop demo state and submits a local-chain payment that uses wallet balance and daily cap; run it only on an isolated funded deployment.
The `security-only` mode is stateful because it creates mandates and freezes an agent, even when it avoids another payment.
The current `callback-failure` branch selects another product but does not induce a shop callback failure, so do not use it as evidence of that recovery path.
The [verification record](../docs/verification.md) separates earlier observed callback failure evidence from what the current driver can reproduce.

For a manual owner walkthrough, start the launcher, open the app on port 8081, enter the private bootstrap token, and confirm the main and Agent Wallet balances.
Fund the Agent Wallet with the app's simulated owner confirmation, pair the WeBank connector, and create a bounded mandate from the user's request before using the shop MCP tools.
Use BaoTaoShop to find the requested item and create its signed checkout request, then pass that unchanged request and the active mandate ID to `request_payment`.
Review any pending app approval, then check `get_payment_status`, `list_my_payments`, the app receipt, and the shop order for the same result.
The WeBank MCPB installs only the nine WeBank tools; BaoTaoShop is a separate stdio MCP server with `SHOP_URL=http://127.0.0.1:3001`.
If Claude Desktop already has a manual `webank` entry, disable it when using the MCPB so the nine WeBank tools are not duplicated; retain the separate shop entry.

All merchants and e-CNY balances are simulated, while contract deployments and any later test payments use real transactions on the local FISCO chain.
Web approval uses an explicitly simulated proof and is not Face ID or a Secure Enclave signature.
Gateway session, mandates, reservations, token grants, replay nonces, payment intents, receipts, and the receipt signing identity persist across an ordinary restart in the ignored owner-only runtime directory.
If an unclean stop leaves `scripts/local-demo-runtime/gateway-state.json.lock`, confirm that its recorded PID has exited and follow the exact lock recovery commands in the [Gateway guide](../services/gateway/README.md).
The shop's price and reset controls use the separate owner-only operator token and stay bound to loopback.
This web view is for final owner acceptance only; interim automated checks should use CLI requests or an isolated VM.

## Treasurer recording simulation

The Treasurer is not wired to the wallet in this build.
The runner appends fixed, display-only Bank Console scenes to an owner-only file and makes no funding, payment, audit, or policy call.
After the Console is open, run these commands separately for the two recording beats:

```sh
./scripts/treasurer-simulation.py renewal --amount-fen 4900
./scripts/treasurer-simulation.py poisoned-topup
```

Use `--dry-run` to inspect the selected scene without writing an event.
The Console labels every line `SIMULATION` and reads only the three allowlisted Treasurer scenes from `scripts/local-demo-runtime/console-simulation.jsonl`.
The next recording stage archives that file with the previous demo state, so old simulated lines do not appear in a new take.
