# Implemented MVP architecture

This document describes the code in this repository as of 2026-10-14.
It describes a hackathon prototype with simulated merchants and currency, not a deployed bank payment system.

## Components and boundaries

| Component | Implemented role | State or trust boundary |
| --- | --- | --- |
| `apps/webank-app` | Expo app walkthrough and explicit loopback Gateway mode for agent, approval, pairing, payment, and freeze views. | Default wallet and local Gateway approval are simulations; no production action-bound device signer. |
| `apps/shops` | Next.js mock storefront, Shop MCP tools, cart, checkout, order status, and signed `payreq.v1`. | Products, merchant identities, orders, and payments are demo data; local operator controls are unauthenticated. |
| `agents/connector-mcp` | Five local MCP tools, device-code pairing, scoped token handling, and P-256 request signatures. | Its software key is stored on the user's filesystem and is readable by a same-user process. |
| `services/gateway` | Fastify pairing and payment decision routes, agent signature and replay checks, mandate and policy enforcement, approval state, receipts, and audit records. | State is in memory; the opt-in local composition uses simulated approval, reservation, and risk adapters. |
| `services/guardian` | Optional structured Claude verdict that can make a decision stricter. | Missing key, timeout, refusal, or invalid result requests human review; no live model result is claimed by the default tests. |
| `packages/chain` and `onchain` | Viem adapter and five Solidity contracts for local FISCO BCOS demo settlement and audit anchors. | Uses a local non-SM chain and simulated CNY units, not e-CNY. |
| `services/treasurer` and `services/monitor` | In-memory recurring-payment proposal, funding rules, and invariant alerts. | Not connected to core banking, the app, or on-chain settlement. |

`packages/contracts` holds the Zod wire schemas used by the components.
`packages/crypto` holds shared deterministic signing and verification helpers.

## Payment path exercised in tests

1. A mock shop creates a payment request containing merchant ID, order ID, amount in CNY fen, line items, expiry, nonce, and an Ed25519 signature.
2. The connector can send that request to the Gateway with an agent token, a P-256 signed HTTP request, an idempotency key, and a fresh nonce.
3. The Gateway validates identity, merchant signature, mandate, policy, licence, risk, and Guardian result through its configured dependencies.
4. A payment may be denied, held for user approval, or passed to the chain adapter according to the strictest result.
5. The local FISCO adapter verifies successful `Paid` and `Anchored` events before returning transaction hashes for a signed demo receipt.
6. The loopback Gateway then calls the mock shop's authenticated payment confirmation route and records whether the order became paid.

The complete path above has been exercised by the CLI driver against a live local shop, connector client, loopback Gateway, and FISCO chain with simulated app approval, reservation, and risk.
The CLI driver is not a live Claude session or a phone approval.
The default Expo walkthrough does not call the local FISCO chain.
The explicit loopback web mode can display Gateway payment detail and submit a visibly simulated proof.
The separate limited Gateway fixture seeds read, reject, and freeze examples and cannot complete a payment.
If the shop confirmation callback fails after an on-chain payment, the Gateway retains the transaction hash, returns `reconciliation_required`, and does not claim the shop order is paid.

## Local chain roles

`ECnySim` records simulated CNY units.
`MerchantRegistry` stores mock merchant identity, payout address, and public key.
`LicenceRegistry` stores agent licence data.
`AgentWallet` enforces per-payment, UTC daily, and calendar-month caps, duplicate prevention, and bank freeze on the local chain.
`AuditAnchor` records hashes for decision evidence, including a successful anchor transaction for a denied request.
The bank signer and Gateway signer are separate local test keys.
The local chain's transaction hashes are not publicly resolvable without access to that chain.

## Current security limits

The Gateway's state, tokens, nonces, mandates, approvals, and audit records do not survive a restart.
The app has no bank-verifiable biometric signing key, and the connector's local software key is not protected from a same-user AI with filesystem access.
The mock shop's admin controls must remain on loopback and must not be exposed to an untrusted network.
Guardian output can only tighten a decision, but no live model resistance to prompt injection has been demonstrated by the deterministic suite.
Treasurer and monitor results are simulation outputs and do not move real money.
