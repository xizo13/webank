# Implemented prototype architecture

This document describes the source in this repository as of 2026-10-19.
It is a local hackathon prototype with simulated merchants and currency, not a deployed bank payment system.

## Components and boundaries

| Component | Implemented role | State or trust boundary |
| --- | --- | --- |
| `apps/webank-app` | Expo source for the browser wallet, pairing, mandates, approvals, funding, payments, and agent controls. | The tested interactive target is a web export with visibly simulated owner approval; an iOS build has not been verified. |
| `apps/shops` | Next.js mock storefront and Shop MCP tools for products, carts, checkout, order status, and signed payment requests. | Merchant identities, inventory, orders, and payments are demo data; local operator controls have no authentication. |
| `agents/connector-mcp` | Nine local MCP tools for pairing, wallet status, mandates, payments, approval waits, and own history. | Its P-256 software key is stored on the user's filesystem and is readable by a process with the same user's access. |
| `services/gateway` | Pairing, scoped agent authentication, mandate and payment checks, owner approval state, receipts, and audit records. | The limited fixture is in memory; the separate loopback FISCO demo stores private state on disk for one local process. |
| `services/guardian` | Optional structured Claude verdict that can make a decision stricter. | The local demo uses the fail-closed unavailable mode, not a demonstrated live model verdict. |
| `packages/chain` and `onchain` | Viem adapter and five Solidity contracts for local FISCO settlement and audit anchors. | The chain uses simulated CNY units, not e-CNY. |
| `services/treasurer` and `services/monitor` | Proposal, funding-rule, and invariant-alert simulations. | They do not connect to core banking or the local payment settlement path. |

`packages/contracts` holds the shared Zod wire schemas.
`packages/crypto` holds deterministic signing and verification helpers.

## Pairing and payment flow

1. The connector creates a P-256 key and requests a device pairing with its app name, provider, and scopes.
2. The browser app shows the owner a consent card and a countdown without showing the connector's six-digit request number.
3. The owner enters that number and uses the explicitly simulated local approval step.
4. Each approved pairing creates a new independent L-plate agent identity, while old agent and audit records remain.
5. The connector proposes a bounded mandate from the user's request before shopping.
6. The owner funds the simulated Agent Wallet and approves the mandate in the browser demo.
7. A mock shop signs a checkout request with the merchant, order, amount, lines, expiry, and nonce.
8. The connector submits that unchanged request with an agent token, P-256 signed HTTP request, idempotency key, and fresh nonce.
9. The Gateway checks the merchant signature, agent identity, mandate, policy, licence, risk, and Guardian result.
10. A payment may be denied, held for owner approval, or passed to the chain adapter according to the strictest result.
11. The FISCO adapter verifies matching `Paid` and `Anchored` events before returning transaction hashes for a signed demo receipt.
12. The loopback Gateway confirms the mock shop order after settlement and holds uncertain callback results for operator reconciliation.

The CLI integration driver exercised a simulated-currency purchase across the shop, connector client, loopback Gateway, and local FISCO chain.
That run used simulated app approval, reservation, and risk inputs.
A separate owner browser session completed fresh agent pairing and anchored its audit record on the local chain.
A live Claude shopping session with a bank-verifiable phone approval has not been demonstrated.

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
The mock shop's admin controls must remain on loopback.
The local Gateway does not have an automatic recovery worker for uncertain chain or shop callback results.
The Treasurer and monitor are separate simulations and do not move real money.
