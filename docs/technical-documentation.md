# Technical Documentation - We-AIlowance

Status: submitted for the WeBank Fintechathon 2026, 2026-10-20.
WeBank Fintechathon 2026, International Track, Topic F (Agent Wallet).
Student prototype; not a WeBank product.
Currency is a simulated e-CNY token (`ECnySim`) on a local FISCO BCOS chain, merchants are mock shops, and the biometric step in the web demo is simulated.

"We don't trust AI agents. We license them."

## 1. What it does

AI agents are starting to shop for people, but giving an agent money is all or nothing.
The Agent Wallet is a separate pot of money inside the user's bank account that AI agents can spend from, under rules enforced by the bank rather than by the AI.

1. The user turns on the Agent Wallet and moves money into it; the main account stays out of the agent's reach.
2. The user pairs each client app separately, with a pairing code, a one-time request number and a biometric confirmation.
3. For each task, the agent proposes a mandate: a locked description of what the user wants (merchant, product, variant, budget, expiry).
4. The agent shops at any merchant and hands the merchant's ordinary signed payment request to WeBank; merchants change nothing.
5. WeBank checks the request in code, shows one approval at payment for an attended purchase, and settles on chain within hard contract caps.
6. Settled payments get a signed receipt and an on-chain audit anchor.
   The Gateway audits decisions that reach its durable decision pipeline; early malformed requests can be rejected before a payment receipt exists.

## 2. System architecture

```
 User (WeBank app) ---- approve / freeze / fund ----+
                                                    |
 Claude --MCP--> WeBank connector --signed HTTP--> Gateway --(checks + Guardian)--> AgentWallet contract --> Merchant payout
   |                (holds agent key)                 |                                   |
   +--MCP--> Mock shop (signed payment request)       +-- audit anchor --> AuditAnchor     +-- FISCO BCOS (local)
```

| Component | Technology | Role |
|---|---|---|
| WeBank app | Expo (React Native, TypeScript); web export in the local demo | Balances, bidirectional owner transfers, owner spending limits, app-scoped pairing consent, payment approvals, idle re-approval, trust-light review and return, freeze, unfreeze, delete, and QR scanning |
| Mock shops | Next.js storefront + Shop MCP server | Catalogue, cart, shipping address, checkout producing an Ed25519-signed payment request and QR, order status, demo controls |
| WeBank connector | MCP server (stdio), TypeScript | Separate credential namespace per initialized client app, pairing, mandates, payment requests, status and renewal; signs with each app's P-256 key under RFC 9421 |
| Gateway | Fastify, TypeScript; durable local state | Agent identity and tokens, mandates, decision pipeline, approvals, reservations, settlement, receipts, audit |
| Guardian | Nous Research Hermes Agent API-server transport implemented; dedicated authenticated zero-tool profile passed its live tool audit and synthetic decision smoke on 2026-10-19; full app acceptance is pending | Reviews one verified purchase per stateless call; a strict verdict can only make a decision stricter |
| Chain adapter | viem over FISCO BCOS Web3 RPC | Deploys and calls contracts; normalises FISCO-specific behaviour |
| Contracts | Solidity 0.8.11, EVM target `london` | `ECnySim`, `MerchantRegistry`, `AgentWallet`, `LicenceRegistry`, `AuditAnchor` |
| Treasurer and monitor | TypeScript (tested simulation) | Just-in-time funding proposals and invariant watchdog; not connected to the live wallet |
| Shared packages | `packages/contracts` (Zod schemas), `packages/crypto` | One schema source for every request, response and event |

Chain: FISCO BCOS v3.17.1, the open-source permissioned blockchain started by WeBank, run locally as a four-node Air chain, non-SM, with its Ethereum-compatible Web3 RPC (chain ID 20200).

## 3. Core algorithms

### 3.1 Intent locking (mandates)

A mandate records what the user decided, so nothing later in the shopping can change it.
How much is locked depends on how specific the user was:

| Intent level | Locked | Checked by code at payment time |
|---|---|---|
| Open | Category, budget, must-have attributes, expiry | Category, amount, registered merchant |
| Product | Plus brand, model, variant, condition, GTIN, quantity | Plus the signed line item's GTIN, variant and options |
| Listing | Plus merchant ID and the shop's SKU | Plus exact merchant and SKU |

The agent holds only the mandate ID; any change is a new mandate.
An attended one-time mandate is stored as immutable `pending_checkout` before shopping, with no hold and no spending authority.
The Gateway reserves its budget only after the owner approves the one payment card, before settlement.
Standing or unattended mandates are approved or autonomously activated at creation and reserve their budgets then.
Each active mandate allows one payment in flight.
Merchant identity comes from the merchant-signed request and the merchant registry, never from the agent or a web page.
Trusted SKU and GTIN data establish the product brand and model; a signed merchant label cannot turn one model into another.

### 3.2 Decision pipeline

For each payment request the Gateway runs, in order: agent authentication, rail validation, mandate, policy and trust light, risk, and the Guardian.
Each check returns pass, step up (ask the user) or deny; the final decision is the strictest result.
Any error, timeout or uncertain result fails closed.
Before showing a composite approval card and again when the owner approves it, the Gateway simulates the exact contract payment against current balance, freeze, and caps.
Proven cap failures deny before any transfer.
The Guardian runs only when no deterministic check has denied.
A fully locked listing may skip Guardian when the payment already requires the owner, but Green auto-payment always requires an actual Guardian pass on the exact signed order.
A Guardian "pass" never loosens a deterministic step-up.
The Gateway checks Hermes's advertised API-server toolsets before each Guardian call.
Hermes v0.21 does not include every possible MCP or plugin tool in that response, so an operator must separately inspect a dedicated profile with no MCP or plugin registrations, memory, or skills.
The Gateway requires an explicit local confirmation of that audit before it makes any Guardian call.
A nonempty or unverifiable advertised tool list, missing confirmation or local configuration, timeout, refusal, or invalid verdict sends the purchase to the owner and never authorizes an automatic payment.
Each decision has one structured input and no conversation or memory carried from earlier calls.
The endpoint and key are supplied locally through uncommitted environment configuration.
The Treasurer model proposal step is future work; its executor and invariant monitor remain deterministic.

### 3.3 Trust lights and auto-approval

The Gateway keeps one light per paired client app:

| Light | Spending rule |
|---|---|
| Amber | Every purchase needs the owner's approval, even ¥1 |
| Green | A purchase at or below the owner's threshold (default ¥100) may auto-pay only after all checks pass; larger allowed purchases need one owner card |
| Red | All spending is denied until the owner reviews the history and returns it to Amber with a fresh biometric action |

An attended one-time mandate waits for the merchant-signed checkout.
Amber gets one composite payment approval, while eligible Green may settle without a card.
The card binds the user's locked intent and the signed merchant, items, shipping and total to one action hash.
An Amber agent's first purchase uses zero-trust number matching on that payment card, and every later Amber purchase still needs the user.
An unattended or standing mandate needs approval at creation unless Green and the owner's threshold allow autonomy.
Its later payments follow the trust light, risk and Guardian rules and may need a step-up.
Five clean owner-approved paid purchases and one bank-recorded passed drill with no flag in the previous 30 days move Amber to Green.
A move into Amber from Green or Red starts a fresh qualification period; older good history remains visible but does not immediately restore Green.
A verified failed drill or upheld dispute moves the agent to Red; one flag moves Green to Amber, and two distinct flags in 30 days move any light to Red.
The local demo Green fast-forward is an explicit simulated owner control and does not fabricate paid orders or drill passes.
The user's freeze is separate and overrides every light.

### 3.4 Approval with number matching

For zero-trust approvals the Gateway generates a random 6-digit request number, the connector shows it to the user (including as a macOS notification), and the user types it into the WeBank app before approving.
This proves the request in the app is the one the user is looking at, and stops approval fatigue.
Three wrong numbers cancel the request.
Approvals are bound to the action hash and expire after 180 seconds.

### 3.5 Request signing and replay protection

The agent's P-256 key signs each Gateway request per RFC 9421 (method, path, content digest, idempotency key, created and expiry time, nonce, key ID).
Nonces cannot be reused, and an idempotency key cannot be reused with a different body.
Merchants sign payment requests with Ed25519 over merchant, order, amount, line items (SKU, GTIN, variant, options), shipping, expiry and nonce.

### 3.6 App identity and idle renewal

One pairing covers every chat in one MCP client app, such as Claude Code.
Another app on the same Mac gets a separate key, owner consent, agent record and trust light.
The connector derives a stable credential namespace from the MCP initialize client name and never accepts a tool argument as app identity.
The client name is self-reported, so the local software-key demo prevents accidental sharing but cannot stop a malicious process running as the same OS user from impersonating an app.
After seven days without a completed payment or owner authorization, the Gateway blocks spending and token refresh even with a still-valid token.
The owner can re-approve that same agent and key in the app with a fresh simulated biometric step; the action is audited before any authority returns.
Read-only checks, failed requests and new chats never reset the idle clock.
Idle re-approval cannot unfreeze, change a trust light, approve a purchase or revive a revoked key.

### 3.7 Settlement and reconciliation

After approval or a fully checked eligible Green auto-decision, the Gateway calls `AgentWallet.pay`, which enforces the caller (Gateway only), freeze, one payment per payment ID, and per-payment, daily and monthly caps, then transfers to the merchant's registered payout.
The Gateway confirms the `Paid` and `Anchored` events before issuing a signed receipt and notifying the shop.
If settlement or the shop callback is uncertain, the payment is locked for reconciliation and never retried in a way that could pay twice.

The owner can review and change the exact per-payment, daily, monthly, and Green auto-approval thresholds in the app.
A limit increase needs a fresh simulated biometric review of the exact change.
The bank-only signer updates the contract caps after an audit anchor, and the Gateway activates matching policy only after exact readback.
Pending changes and cap mismatches block new spending.
The contract's UTC calendar day and month define the spending windows.
A denied payment remains denied after a cap increase and requires a fresh signed checkout.
Transfers between the simulated main account and Agent Wallet show both fixed endpoints and let the owner reverse direction; the return route can move only unreserved funds.

### 3.8 Chain adapter for FISCO BCOS

FISCO BCOS returns reverts with RPC error code 16 and an empty message, uses millisecond block timestamps, and returns a malformed log-level transaction index.
The adapter decodes revert data with the contract ABI, normalises timestamps to one unit, and ignores the malformed field.

## 4. Security design

Summary; full detail and the known-risk list are in the Security Self-Assessment.

- No AI can move money on its own authority: the agent proposes, code and the user decide, and the contract caps everything.
- Three layers: deterministic Gateway checks, user approval, and on-chain caps.
- The agent never sees credentials, the main account or other mandates; its key stays in the connector.
- The agent cannot approve its own payment, restore a freeze or Red light, or complete its own idle re-approval.
- Only owner and bank-controlled routes can change a trust light; a shop, agent, or Guardian cannot fast-forward Green or start a bank drill.
- The Guardian AI and the Treasurer AI are untrusted too: the Guardian can only escalate, and a deterministic monitor freezes the Treasurer on any invariant breach.
- Settled payments have a signed receipt and on-chain anchor; Gateway decision records also preserve denials that reach the durable pipeline.

## 5. Running it

See the repository README for requirements and commands.
In short, on macOS arm64 with Node.js 22 and pnpm via Corepack:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check                 # lint, build, typecheck, tests
./scripts/local-demo-up.sh          # app, shop, Gateway and local FISCO chain on loopback
./scripts/local-demo-down.sh
```

## 6. Tests

The default gate runs Biome lint, builds, TypeScript checks and the Vitest suite; opt-in tests run against the live local FISCO chain.
The red-team and Gateway suites cover the attacks listed in the Security Self-Assessment, including look-alike products, swapped payees, tampered amounts, forged merchants, replays, double payment, a fooled or unavailable Guardian, frozen agents and uncertain settlement.

## 7. Built and not built

| Built and tested | Designed, not built yet |
|---|---|
| Separate Agent Wallet, funding and sweeping | Native iPhone build with Secure Enclave approval signing |
| Pairing with request numbers, re-pair and disconnect | Production biometric and app attestation |
| Mandates with intent locking (GTIN, SKU, variant) | Transaction push notifications |
| Decision pipeline with fail-closed Hermes transport tests; dedicated zero-tool Hermes profile passed a synthetic live smoke | Full shop-to-app Hermes acceptance and Treasurer connected to the wallet |
| On-chain settlement, caps and audit anchors on FISCO BCOS | Refund routing by reason |
| Human QR payment from the main account | Public checkpoint of audit fingerprints |
| Treasurer and monitor as a tested simulation | |
