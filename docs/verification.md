# Verification and known limits

This record separates the default automated gate, opt-in local FISCO evidence, and acceptance still pending as of 2026-10-14.

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

These hashes belong to a local permissioned chain and are not independently resolvable in a public explorer.
The CLI driver used an in-memory connector credential store, simulated app approval and reservation, a fixture risk result, and an unavailable Guardian.
It did not use a live Claude session, native Face ID signer, bank account, actual e-CNY, or real merchant.
The [local demo guide](../scripts/local-demo-README.md) explains the bounded operator path and preserved private runtime.
The separate `spike-fisco/REPORT.md` in the public checkout records the earlier compatibility proof.

## Acceptance and deployment limits

- Final visual acceptance of the latest Expo presentation is pending on a suitable device or isolated VM.
- A local Face ID prompt is not a bank-verifiable approval signature; the Secure Enclave action signer is not implemented.
- Gateway sessions, tokens, nonces, mandates, reservations, approvals, and audit records are in memory and do not survive a restart.
- The connector uses a local software key readable by a same-user process.
- The limited Gateway fixture cannot approve or pay; the separate opt-in local-demo listener uses simulated app proof and real local-chain test-token transactions.
- The Treasurer is not wired to banking or chain settlement.
- The mock shops and `ECnySim` do not represent real merchants or e-CNY.
- There is no durable recovery worker for an uncertain chain or shop callback result.

Do not use this prototype with real payment credentials, customer records, or funds.
