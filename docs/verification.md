# Verification and known limits

This record separates the default automated gate and opt-in local FISCO evidence recorded on 2026-10-14 from the current operator limits.
The historical results below do not constitute a fresh full workspace gate for later changes.

## 2026-10-20 current draft checks

The reviewed implementation source passed TypeScript and Biome checks outside this public checkout.
Its Gateway suite passed 125 tests, including owner policy cap change cases.
Its app suite passed 69 tests, including the transfer and policy limit controls.
An isolated web export passed, but refreshed owner browser acceptance of the transfer and limit screens remains pending.
The public checkout's 40 Python launcher tests passed, including private Hermes configuration isolation checks.
Five focused Gateway token tests passed in the reviewed implementation source.
Both standalone Gateway listeners require an absolute path for a new mode `0600` token file before listening and do not print the token.
The public checkout has no installed workspace dependencies and has not passed its own full workspace gate or CI for this draft.
The dedicated zero-tool Nous Research Hermes Agent profile passed a live synthetic smoke test with three decisions.
That smoke test did not run a signed purchase from the shop through the Gateway and app, so full Guardian acceptance remains pending.
The real local FISCO owner cap write remains pending acceptance.
The browser app still uses simulated approval proof, and no iPhone build or on-device test is claimed.

## 2026-10-19 earlier source publication checks

The current product source passed Biome lint across 131 files and TypeScript checks across all 11 workspace projects with a typecheck script.
Vitest passed 147 tests with three opt-in tests skipped when two suites that bind `127.0.0.1` were excluded.
The sandbox denied those suites permission to open a local listener, so the full default Vitest command is not recorded as passing for this date.
The launcher passed 34 Python unit tests.
The connector extension test built a self-contained MCPB, loaded its nine tools from another directory, and verified that the archive contains bundled dependency license texts.
The public checkout still needs a clean dependency install and its own full CI run after publication.

In an owner browser session, a fresh pairing created an independent agent and anchored its audit record on the preserved local FISCO chain.
The owner has not completed the shopping payment portion of the latest interactive demo run.
The browser approval remains simulated, and no iPhone build or on-device test is claimed.

## Default workspace gate

Run from the repository root after installing the pinned workspace dependencies:

```sh
corepack pnpm check
```

The final local gate passed on 2026-10-14:

| Gate | Recorded result |
| --- | --- |
| Biome lint | 103 files checked, no fixes needed. |
| Build | Workspace packages, optimized Next shop, and five Solidity contracts built; Solidity used solc 0.8.11 with the `london` target. |
| TypeScript | All 11 workspace projects with a typecheck script passed. |
| Vitest | 84 tests passed in 15 files; the opt-in live FISCO payment test was skipped. |

The monitor regression test confirms that a malformed restored snapshot emits `invalid_snapshot` and calls the Treasurer freeze callback without throwing.
The default tests cover shop signatures and price snapshots, connector MCP calls and signed requests, Gateway pairing and decisions, local-demo composition, red-team denial cases, and Treasurer and monitor simulation rules.
The local-demo composition test uses injected chain and shop adapters, so its passing result alone does not prove a FISCO transaction.

## Opt-in local-chain evidence

An earlier opt-in Gateway FISCO test submitted a 27,900 fen demo payment on a four-node non-SM FISCO BCOS v3.17.1 chain.
It observed matching `Paid` and `Anchored` events, verified the signed receipt, recorded a tampered-request denial, and confirmed that a frozen agent could not make a later Gateway request.
That test used fixture app approval, reservation, risk, and Guardian adapters.

The later CLI integration driver exercised the actual local shop HTTP checkout, connector client and P-256 request signing, loopback Gateway composition, FISCO settlement, authenticated shop callback, and app payment detail in one path.
The successful simulated-currency purchase was 27,900 fen, with payment transaction `0x44ddf09818149eb3bbd6ac14667216383acfd631b78fbd8787828616fcf9b108` and audit anchor `0xf4166fb49abd4bf8c227f0103108cd55c02a3169e78cfcb80d801b1d32ec1010`.
The shop order, connector status, and app detail all reported the same payment hash.
A security-only run verified rejection of a changed signed request, a honeypot merchant, and a frozen agent without sending another 27,900 fen payment.
A callback-failure run put an 8,800 fen test-token payment on FISCO but returned `503 reconciliation_required`, retained transaction `0x4f0acce11f4ca7efe14a8e97f927e66b689c9a8209b6edf796a6248c1976be17`, and left the shop order awaiting payment.
The app detail also returned 503, so the callback failure did not create a false paid record.
That is historical evidence from the earlier run.
The current `callback-failure` CLI mode only chooses a different product and does not force the shop callback to fail, so it must not be used as a new callback-failure test without a fault injector.

These hashes belong to a local permissioned chain and are not independently resolvable in a public explorer.
The CLI driver used an in-memory connector credential store, simulated app approval and reservation, a fixture risk result, and an unavailable Guardian.
It did not use a live Claude session, native Face ID signer, bank account, actual e-CNY, or real merchant.
The [local demo guide](../scripts/local-demo-README.md) explains the bounded operator path and preserved private runtime.
The separate `spike-fisco/REPORT.md` in the public checkout records the earlier compatibility proof.

## Acceptance and deployment limits

- The owner visually inspected the browser pairing flow; full screen and iPhone acceptance remain pending.
- A local Face ID prompt is not a bank-verifiable approval signature; the Secure Enclave action signer is not implemented.
- The limited Gateway fixture keeps state in memory; the opt-in loopback local-demo Gateway persists private sessions, tokens, nonces, mandates, reservations, approvals, payment intents, receipts, and its receipt signing identity across an ordinary restart.
- The local-demo launcher preserves its chain deployment and shop state across an ordinary restart; `--fresh` archives both the prior Gateway state and shop state with the old address manifest, then starts a new funded deployment with a zero-balance Agent Wallet.
- The current CLI driver does not fund that new wallet, so a funded run needs an owner app funding step before creating a mandate.
- The connector uses a local software key readable by a same-user process.
- The limited Gateway fixture cannot approve or pay; the separate opt-in local-demo listener uses simulated app proof and real local-chain test-token transactions.
- The Treasurer is not wired to banking or chain settlement.
- The mock shops and `ECnySim` do not represent real merchants or e-CNY.
- There is no automatic recovery worker for an uncertain chain or shop callback result; the loopback Gateway durably holds such work for operator reconciliation.

Do not use this prototype with real payment credentials, customer records, or funds.
