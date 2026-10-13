# Agent Wallet Protocol - One Purchase, End to End

Status: brainstorm draft.
Last updated: 2026-10-13.

## 1. Core idea

The agent is a courier of the bill, never the payer.
The merchant shows a payment request through its existing rail (like a QR code or payment link).
The agent picks it up and hands it to WeBank.
WeBank decides, then pays the merchant through the same rail.
The merchant sees an ordinary payment and changes nothing.

## 2. Actors

| Actor | Role | Trust level |
|---|---|---|
| User | Owns the money, sets rules, approves step-ups | Root of trust |
| WeBank app | Where the user sets rules and approves | Trusted |
| Agent (Claude, ChatGPT, etc.) | Browses, builds the cart, requests payment | Untrusted; can be tricked |
| Merchant | Sells; presents a payment request via its rail | Untrusted |
| WeBank Agent Gateway | Authenticates agents, runs the decision pipeline | Trusted |
| Guardian AI | Checks intent vs. cart, explains decisions | Advisory; can only make decisions stricter |
| Rail (e-CNY sub-wallet, simulated on FISCO BCOS) | Moves the money | Trusted |
| Audit chain | Tamper-proof log of mandates and decisions | Trusted |

## 3. Flow overview

```
Phase 0  Enroll (once)      User <-> WeBank app <-> Agent      agent gets identity + key
Phase 1  Intent (per task)  Agent -> Gateway -> User app      mandate created, budget reserved
Phase 2  Browse             Agent <-> Merchant                outside our system
Phase 3  Checkout           Merchant -> Agent -> Gateway      payment request handed over
Phase 4  Decide             Gateway pipeline (7 checks)       APPROVE / STEP_UP / DENY
Phase 5  Execute            Gateway -> Rail -> Merchant       ordinary payment, merchant unchanged
Phase 6  Record             Gateway -> Audit chain + app      tx hash, receipt, notification
```

## 4. Phase 0 - Enroll an agent (once)

1. User turns on agent mode in the WeBank app and funds the agent sub-wallet.
2. User sets the account policy (standing limits).
3. Agent starts a connection: it generates its own key pair and shows a short pairing code (OAuth device-flow style).
4. User enters or scans the code in the WeBank app and confirms with biometrics.
5. Gateway registers the agent (Know Your Agent record) and binds its public key.
6. Agent receives a scoped token; every later request must be signed with its private key.

Result: a stolen token alone is useless, and the agent never sees any WeBank credential.

### Onboarding model: "as easy as `gh auth login`"

Same pattern as GitHub: set everything up on the website (here, the WeBank app), then authorize each tool once.

Two connection paths, one consent screen:

| Path | For | How it works | Standard |
|---|---|---|---|
| Device code | Terminal and headless agents (Claude Code, scripts, desktop assistants) | Agent shows a short code (e.g. `WQ7K-3MXP`); user scans or types it in the WeBank app | OAuth 2.0 Device Authorization Grant (RFC 8628) |
| In-chat connector | Chat assistants with connector support (Claude, ChatGPT via MCP) | User clicks "Connect WeBank" in the assistant; redirected to WeBank (QR on desktop, app on mobile) | OAuth 2.0 Authorization Code + PKCE |

Both end in the same WeBank consent screen:

```
Claude (Anthropic) wants to use your Agent Wallet
Device: MacBook Pro, Shenzhen        Requested: 2026-10-13 14:02

It will be able to:
  - Request payments within your limits (¥300 per payment)
  - See its own payment history
It will NOT be able to:
  - See your main account or balance
  - Change your limits
  - Move money to people

Starts on: L-plate licence
[ Deny ]                    [ Authorize with Face ID ]
```

### What we borrow from GitHub

| GitHub feature | Agent Wallet equivalent |
|---|---|
| `gh auth login` device flow | Device code pairing for terminal agents |
| OAuth app consent screen | Consent screen listing exactly what the agent can and cannot do |
| Fine-grained tokens with scopes and expiry | Scoped agent token; expires; renewable from the app |
| Settings > Applications (authorized apps, revoke) | "Connected agents" list with licence level, last used, revoke |
| SSH key registration | Agent's public key bound to its identity (KYA) |
| Sudo mode for sensitive settings | Biometric re-check to loosen limits (tightening is instant) |
| Security log | Per-agent audit log, anchored on-chain |

### Scopes

| Scope | Allows | Default |
|---|---|---|
| `wallet:pay` | Request payments under a mandate | On |
| `wallet:mandate` | Propose mandates (user still confirms above threshold) | On |
| `wallet:history:self` | Read this agent's own transactions | On |
| `wallet:balance` | See the agent sub-wallet balance | Off |
| Main account, transfers to people, limit changes | Never grantable to an agent | Not available |

### Onboarding risks

- Device-code phishing: an attacker sends the user a code to approve for the attacker's agent.
  Mitigations: consent screen shows agent name, device, location and time; codes expire in 10 minutes; new agents start on L-plates so damage is capped.
- Reach depends on agent platforms: closed ecosystems (e.g. Doubao, Qwen) may not allow third-party wallet connectors.

### Agent record (KYA)

```json
{
  "agent_id": "agt_7f3a",
  "owner": "user_123",
  "provider": "Anthropic Claude",
  "public_key": "ed25519:...",
  "risk_tier": "standard",
  "max_autonomy": "L3",
  "status": "active",
  "created_at": "2026-10-13T10:00:00+08:00"
}
```

### Account policy (standing limits)

```json
{
  "per_payment_max": 300,
  "daily_max": 500,
  "monthly_max": 1000,
  "auto_approve_below": 100,
  "blocked_categories": ["gift_cards", "crypto", "gambling", "money_transfer"],
  "new_merchant_requires_tap": true,
  "currency": "CNY"
}
```

## 5. Phase 1 - Create an intent mandate (per task)

The user tells the agent what they want.
The agent turns it into a mandate request and sends it to the Gateway.

```json
{
  "agent_id": "agt_7f3a",
  "description": "Wireless noise-cancelling headphones",
  "max_amount": 300,
  "categories": ["electronics"],
  "max_payments": 1,
  "expires_in": "24h"
}
```

Rules:

- If the mandate fits inside `auto_approve_below`, it is created immediately.
- Otherwise the user gets a card in the WeBank app showing the mandate in plain language and approves with biometrics.
- The amount is reserved from the agent sub-wallet so it cannot be double-spent.
- The mandate hash is anchored on the audit chain.

Why the user confirms: an agent that was tricked could invent its own mandate.
The user's confirmation in the WeBank app is the root of trust, not the agent's word.

## 6. Phase 2 - Browse

The agent compares products and builds a cart.
This is outside our system.
The agent should record the prices it saw, because the Gateway uses them later for price sanity checks.

## 7. Phase 3 - Checkout handoff

The merchant's existing checkout produces a payment request (in the demo: an e-CNY payment order, like the string behind a payment QR code).
The agent calls one wallet tool:

```
request_payment(mandate_id, payment_request, cart, price_evidence, rationale)
```

```json
{
  "mandate_id": "mdt_91c2",
  "payment_request": "ecny://pay?merchant=M88231&order=A-5521&amount=279.00&sig=...",
  "cart": [{"item": "Sony WH-1000XM5", "qty": 1, "unit_price": 279.00}],
  "price_evidence": [
    {"merchant": "Shop A", "price": 279.00},
    {"merchant": "Shop B", "price": 299.00}
  ],
  "rationale": "Cheapest of 3 compared merchants, in stock, ships tomorrow"
}
```

The request is signed with the agent's private key and carries a nonce.

## 8. Phase 4 - Decision pipeline

Checks run in order, cheapest and most deterministic first.
Any DENY stops the pipeline.

| # | Check | What it does | Typical outcome |
|---|---|---|---|
| 1 | Agent auth | Valid signature, fresh nonce, agent active, not frozen | DENY if fails |
| 2 | Rail validation | Resolve merchant from the rail's own registry; confirm amount and order are genuine; decoy merchant = failed fire drill | DENY if forged |
| 3 | Mandate | Active, not expired, amount within reserved budget, category in scope, payment count left | DENY if outside |
| 4 | Account policy + licence | User's caps, blocked categories, new-merchant rule; then the agent's licence level lowers caps further (see brainstorm.md section 12) | DENY or STEP_UP |
| 5 | Risk signals | Velocity, duplicate payments, price far above evidence, unusual agent behavior | STEP_UP or DENY |
| 6 | Guardian AI | Does the merchant and cart match the mandate's intent? Explain why | STEP_UP or DENY |
| 7 | Decide | Combine results into one decision + plain-language reason; update licence points | APPROVE / STEP_UP / DENY |

Key rules:

- Merchant identity comes from the rail registry, never from the agent or the webpage.
  A page can lie about who it is; the rail cannot.
- The guardian is monotonic: it can only escalate (APPROVE to STEP_UP, STEP_UP to DENY), never relax a deterministic decision.
  A fooled guardian therefore cannot unlock anything.
- STEP_UP sends an approval card to the WeBank app; no answer within the timeout means DENY.

### Decision object

```json
{
  "decision_id": "dec_44b0",
  "outcome": "APPROVE",
  "checks": {"auth": "pass", "rail": "pass", "mandate": "pass", "policy": "pass", "risk": "pass", "guardian": "pass"},
  "reason": "Headphones from a verified electronics merchant, ¥279 within ¥300 mandate, cheapest of 3 compared",
  "autonomy_level": "L3"
}
```

## 9. Phase 5 - Execute

1. Gateway pays the merchant from the agent sub-wallet through the rail, with an idempotency key (no double payment on retry).
2. Mandate budget is decremented; single-use mandates are closed.
3. Any unused reserved budget is released back to the sub-wallet.
4. Merchant receives a normal payment notification and fulfills the order.

## 10. Phase 6 - Record and notify

1. An audit record is written for every attempt, including denials.
2. The record hash is anchored on the audit chain, giving a tx hash per decision.
3. The user sees the payment (or blocked attempt) in the WeBank app with the reason.
4. The agent gets a receipt (or the denial reason) to report back to the user.

### Audit record

```json
{
  "audit_id": "aud_0192",
  "agent_id": "agt_7f3a",
  "mandate_id": "mdt_91c2",
  "decision_id": "dec_44b0",
  "merchant_registry_id": "M88231",
  "amount": 279.00,
  "outcome": "APPROVE",
  "reason": "...",
  "timestamp": "2026-10-13T14:22:05+08:00",
  "chain_tx_hash": "0x..."
}
```

## 11. Controls available at any time

- Freeze one agent: its key is revoked; next request fails check 1.
- Freeze all agents: agent mode off; all mandates suspended.
- Cancel a mandate: reserved budget released immediately.
- Edit limits: in the app, or by chat (chat changes that loosen limits need biometric confirmation; tightening is instant).
- Automatic circuit breakers: risk signals can freeze an agent on their own and notify the user.

## 12. Threats this protocol answers

| Attack | Where it is stopped |
|---|---|
| Malicious page swaps in a scam payment request | Check 2 resolves the real merchant; check 3 or 6 sees it does not match the mandate |
| Page tells the agent to buy a gift card | Check 4 blocked category; check 6 intent mismatch |
| Tricked agent creates a big mandate for itself | Phase 1 requires user confirmation in the app |
| Stolen agent token | Check 1 requires the private key signature |
| Replay of an old payment request | Nonce + idempotency key |
| Many small payments to dodge the cap | Daily and monthly caps; velocity check |
| Inflated price | Check 5 compares against the agent's own price evidence and mandate |
| Guardian AI gets fooled | Guardian can only escalate, never approve on its own |
| Agent goes rogue | Freeze switch; circuit breaker auto-freeze |

## 13. On-chain design (bonus)

Option A (minimum): anchor mandate hashes and audit record hashes on FISCO BCOS or a testnet.

Option B (stronger): the simulated e-CNY agent sub-wallet is itself a smart contract.

- It holds the token balance.
- Only the WeBank Gateway address can spend from it.
- Hard caps (per payment, daily) are enforced in the contract, so even a compromised Gateway cannot exceed them.
- Freeze is a contract call.
- Every real payment produces a real tx hash.

Recommendation: Option B, falling back to Option A if time runs short.

## 14. Open design questions

1. Should small mandates be auto-created without user confirmation, or should every mandate need a tap?
2. Should each task get its own mandate, or can recurring tasks (weekly groceries) use one standing mandate?
3. STEP_UP timeout length, and what the agent tells the user while waiting.
4. How does the agent capture the payment request in a real checkout that redirects to the WeChat app? (Demo: mock merchants expose a machine-readable payment request.)
5. Refunds: return to the agent sub-wallet or to the main account?
6. Should the guardian see the user's original wording of the task, or only the mandate?
