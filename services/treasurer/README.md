# Treasurer simulation

This package implements the Demo 6 proposal and funding rules in an in-memory ledger.
It does not move real money or submit chain transactions.
Returned `sim_` references are simulation identifiers, not transaction hashes.

`propose` accepts only structured bank-settled ledger rows after explicit history consent.
It detects three monthly charges to the same merchant for the same amount and proposes funding the prior evening.
Merchant names only label the card and do not affect recurrence detection.

`TreasuryExecutor` accepts a proposal only when its commitments and schedule match exactly.
The Gateway must implement `verifyUserApproval` with a fresh action-bound biometric proof for that proposal hash.
The Gateway must implement `verifyPaymentDecision` for the exact renewal payment.
Core banking must implement `verifyBankFxQuote` and issue a quote that binds the user, commitment, CNY debit, USD credit, and expiry.
Without those verified ports, a proposal or model output cannot transfer funds.

Funding is checked before the simulated transfer by `@webank/monitor`.
Reserved funds are tied to a commitment and merchant; Buffer is capped at the approved target.
A rogue funding attempt or limit breach freezes the Treasurer and emits `monitor.alert` data.
The app and Gateway still need to connect these alerts to audit anchors and notifications.

Run the focused checks from the repository root after workspace dependencies are linked:

```sh
./node_modules/.bin/tsc -p services/monitor/tsconfig.json --noEmit
./node_modules/.bin/tsc -p services/treasurer/tsconfig.json --noEmit
./node_modules/.bin/vitest run services/treasurer/test/treasury.test.ts
./node_modules/.bin/biome check services/monitor services/treasurer
```
