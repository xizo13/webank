# Implemented prototype architecture

This document describes the source in this repository as of 2026-10-20.
It is a local hackathon prototype with simulated merchants and currency, not a deployed bank payment system.

## Components and boundaries

| Component | Implemented role | State or trust boundary |
| --- | --- | --- |
| `apps/webank-app` | Expo source for the browser wallet, pairing, mandates, approvals, owner transfers, policy limits, payments, and agent controls. | The isolated web export and app tests passed; refreshed owner browser acceptance and an iOS build remain pending. |
| `apps/shops` | Next.js mock storefront and Shop MCP tools for products, carts, checkout, order status, and signed payment requests. | Merchant identities, inventory, orders, and payments are demo data; price and reset controls require a separate local operator token. |
| `agents/connector-mcp` | Nine local MCP tools for per-app pairing, wallet status, mandates, payments, approval waits, and own history. | The host supplies its own app name; the P-256 software key is readable by a process with the same user's filesystem access. |
| `services/gateway` | Pairing, scoped agent authentication, attended payment review, owner wallet enablement and cap changes, Amber/Green/Red trust, receipts, audit records, and the read-only Bank Console. | The limited fixture is in memory; the separate loopback FISCO demo stores private state on disk for one local process, and the Console accepts only loopback requests. |
| `services/guardian` | Optional fixed-call Nous Research Hermes Agent review that can make a decision stricter. | A dedicated zero-tool profile passed synthetic live decisions and a signed local shop-to-app acceptance run; no production model security claim follows from this. |
| `packages/chain` and `onchain` | Viem adapter and five Solidity contracts for local FISCO settlement and audit anchors. | The chain uses simulated CNY units, not e-CNY. |
| `services/treasurer` and `services/monitor` | Proposal, funding-rule, and invariant-alert simulations. | They do not connect to core banking or the local payment settlement path. |

`packages/contracts` holds the shared Zod wire schemas.
`packages/crypto` holds deterministic signing and verification helpers.

## Pairing and payment flow

1. The connector creates a P-256 key in a credential namespace derived from the MCP host's self-reported app name and requests pairing with that name, provider, and scopes.
2. The browser app shows the owner a consent card stating that the grant covers every chat in the named app, with a countdown but without the connector's six-digit request number.
3. The owner enters that number and uses the explicitly simulated local approval step.
4. Each approved pairing creates a new independent Amber agent identity, while old agent and audit records remain.
5. The owner funds the simulated Agent Wallet before a purchase.
   In a fresh local deployment, the signed-in owner first enables the wallet with a visibly simulated approval.
6. The connector proposes a bounded, non-spendable `pending_checkout` mandate for an attended purchase before shopping.
7. A mock shop signs a checkout request with the merchant, order, amount, lines, expiry, and nonce.
8. The connector submits that unchanged request with an agent token, P-256 signed HTTP request, idempotency key, and fresh nonce.
9. The Gateway checks the merchant signature, agent identity, locked mandate, policy, trust light, risk, and Guardian result.
10. Amber receives one composite payment approval with locked intent and signed order details; eligible Green can auto-pay below the owner's threshold, while Red is denied.
11. The FISCO adapter verifies matching `Paid` and `Anchored` events before returning transaction hashes for a signed demo receipt.
12. The loopback Gateway confirms the mock shop order after settlement and holds uncertain callback results for operator reconciliation.

An unattended or standing mandate can require owner approval when created because its payment may happen later without the user present.
Seven days without a completed payment or owner authorization pauses an app's agent until the owner Re-approves the same key.
Trust lights change through bank-owned evidence and owner actions; a separate owner freeze always overrides them.
The local Guardian makes one structured Hermes call without prior conversation only after the operator verifies its dedicated no-tool profile.
An unavailable Hermes instance or uncertain tool isolation produces owner step-up, not automatic payment.
The local Bank Console projects bank-owned event fields, short identifiers, allowlisted text, and clearly marked Treasurer simulations without exposing request numbers, keys, raw prompts, or personal data.

The CLI integration driver exercised a simulated-currency purchase across the shop, connector client, loopback Gateway, and local FISCO chain.
That run used simulated app approval, reservation, and risk inputs.
A separate owner browser session completed fresh agent pairing and anchored its audit record on the local chain.
A live Claude shopping session with a bank-verifiable phone approval has not been demonstrated.
The isolated Hermes profile passed a live synthetic smoke test and a signed local shop-to-app acceptance run.
That run included an Amber owner card, a Green ¥77.00 FISCO payment without a card, and a contradictory signed order that Hermes denied without a wallet debit.

The owner transfer code requests simulated CNY moves into the Agent Wallet after labelled simulated biometric confirmation.
It also returns unreserved funds to the fixed main account after explicit owner confirmation without a biometric step.
The policy limit controls prepare and review changes to per-payment, daily, monthly, and Green auto-approval limits.
The Gateway binds a cap write to an audited owner change and checks contract readback, but a real local FISCO cap write and refreshed owner browser acceptance remain pending.

## Local chain roles

`ECnySim` records simulated CNY units.
`MerchantRegistry` stores mock merchant identity, payout address, and public key.
`LicenceRegistry` stores agent licence data.
`AgentWallet` enforces per-payment, UTC daily, and calendar-month caps, duplicate prevention, and bank freeze on the local chain.
`AuditAnchor` records hashes for decision evidence.
The bank signer and Gateway signer are separate local test keys.
The local chain's transaction hashes are not publicly resolvable without access to that chain.

## Current limits

The browser approval proof is a demo marker, not a biometric or Secure Enclave signature.
The iOS source has not been built and tested on an iPhone for this release.
The connector's local software key is readable by a same-user process with filesystem access.
The loopback Gateway persists private state across an ordinary restart but supports only one process and no replicas.
The mock shop's operator controls require a separate local token and remain on loopback.
The local Gateway does not have an automatic recovery worker for uncertain chain or shop callback results.
The Treasurer and monitor are separate simulations and do not move real money.
