# API Contracts

Status: draft for team review.
Last updated: 2026-10-13.

These contracts are the agreement between the four builders.
Once agreed, they live as zod schemas in `packages/contracts`; changing one needs a team review.
Where this file and protocol.md differ, this file wins (e.g. money is in integer minor units here).

## 0. Conventions

| Topic | Rule | Why |
|---|---|---|
| Money | `{ "amount": 27900, "currency": "CNY" }`, integer minor units (fen / cents) | No floating-point rounding errors |
| IDs | Prefixed strings: `usr_`, `agt_`, `mdt_`, `pay_`, `dec_`, `rcp_`, `apr_`, `aud_`, `cmt_`, `prp_`, `ord_`, `mch_` | Readable logs; type obvious at a glance |
| Time | RFC 3339 with offset, e.g. `2026-10-13T14:22:05+08:00` | Unambiguous |
| Versioning | URL prefix `/v1`; every stored schema has `"schema": "mandate.v1"` etc. | Safe upgrades |
| Idempotency | `Idempotency-Key` header on every POST that moves money or creates state; same key + different body = 409 | Retries never double-pay |
| Errors | `{ "error": { "code": "mandate_expired", "message": "...", "decision_id": "dec_..."? } }` | One shape everywhere |
| Pagination | `?limit=50&cursor=...` -> `{ "items": [], "next_cursor": null }` | Standard |

### Auth types

| Caller | How it authenticates | Used on |
|---|---|---|
| Agent (via connector) | `Authorization: Bearer <access_token>` + RFC 9421 `Signature-Input` / `Signature` over `@method`, `@path`, `content-digest`, `idempotency-key`, with `created`, `expires` (max 60s), `nonce`, `keyid=agt_...` | `/v1/agent/*` |
| WeBank app | Session cookie (demo login) | `/v1/app/*` reads |
| WeBank app, sensitive action | Session + fresh WebAuthn assertion over the exact action payload hash | Approve payment, approve mandate, approve pairing, loosen limits, approve Treasurer schedule, unfreeze |
| Internal services | Service token on a private network; never exposed | Guardian, Treasurer, Monitor, Executor |
| Shop | Merchant key (Ed25519) signs each payment request | Payment request verification |

Rule: no sensitive action is ever accepted from a request that came from an AI (agent, Guardian, Treasurer, chat).

## 1. Shared objects

### Agent

```json
{
  "schema": "agent.v1",
  "agent_id": "agt_7f3a",
  "user_id": "usr_123",
  "display_name": "Claude (Anthropic)",
  "provider": "anthropic",
  "public_key": "ed25519:base64...",
  "scopes": ["wallet:pay", "wallet:mandate", "wallet:history:self"],
  "licence": { "level": "L", "points": 0, "clean_purchases": 0, "drills_passed": 0 },
  "status": "active",
  "created_at": "2026-10-13T10:00:00+08:00",
  "last_used_at": null
}
```

`status`: `active | frozen | revoked`.
`licence.level`: `L | P | FULL | SUSPENDED`.

### Policy (user's standing limits)

```json
{
  "schema": "policy.v1",
  "user_id": "usr_123",
  "per_payment_max": { "amount": 30000, "currency": "CNY" },
  "daily_max": { "amount": 50000, "currency": "CNY" },
  "monthly_max": { "amount": 100000, "currency": "CNY" },
  "auto_approve_below": { "amount": 10000, "currency": "CNY" },
  "blocked_categories": ["gift_cards", "crypto", "gambling", "money_transfer"],
  "new_merchant_requires_tap": true,
  "treasurer": {
    "enabled": true,
    "buffer_target": { "amount": 20000, "currency": "CNY" },
    "daily_topup_ceiling": { "amount": 50000, "currency": "CNY" },
    "monthly_topup_ceiling": { "amount": 150000, "currency": "CNY" },
    "protected_main_balance": { "amount": 300000, "currency": "CNY" }
  }
}
```

Effective cap for a payment = min(policy cap, licence cap, mandate cap).

### Mandate

```json
{
  "schema": "mandate.v1",
  "mandate_id": "mdt_91c2",
  "agent_id": "agt_7f3a",
  "agent_key_binding": "ed25519:base64...",
  "description": "Wireless noise-cancelling headphones",
  "user_text": "get me good headphones for my flight, around 300",
  "constraints": [
    { "type": "amount_range", "max": { "amount": 30000, "currency": "CNY" } },
    { "type": "categories", "allowed": ["electronics"] },
    { "type": "allowed_merchants", "merchant_ids": null },
    { "type": "recurrence", "frequency": "NONE", "max_occurrences": 1 },
    { "type": "budget", "max": { "amount": 30000, "currency": "CNY" } },
    { "type": "execution_window", "not_before": null, "not_after": "2026-10-14T14:00:00+08:00" }
  ],
  "status": "active",
  "spent": { "amount": 0, "currency": "CNY" },
  "occurrences": 0,
  "in_flight_payment_id": null,
  "approved_by": "user_webauthn",
  "created_at": "2026-10-13T14:00:00+08:00"
}
```

`status`: `pending_user | active | exhausted | expired | cancelled`.
`user_text` is captured on the WeBank approval screen, not taken from the agent.
`approved_by`: `auto_threshold | user_webauthn`.

### Payment request (produced by the shop, unchanged by the agent)

```json
{
  "schema": "payreq.v1",
  "merchant_id": "mch_shopA",
  "order_id": "ord_5521",
  "amount": { "amount": 27900, "currency": "CNY" },
  "line_items": [{ "sku": "SONY-XM5-BLK", "name": "Sony WH-1000XM5 Black", "qty": 1, "unit_price": { "amount": 27900, "currency": "CNY" } }],
  "expires_at": "2026-10-13T14:37:00+08:00",
  "nonce": "b64...",
  "merchant_sig": "b64..."
}
```

Transported as a string: `ecny://pay?d=<base64url(json)>` (also rendered as a QR on the shop's checkout page).
The Gateway verifies `merchant_sig` with the key registered for `merchant_id` in the MerchantRegistry contract.
Merchant-signed line items are trusted; anything else the agent says about the cart is a claim.

### Decision

```json
{
  "schema": "decision.v1",
  "decision_id": "dec_44b0",
  "payment_id": "pay_1a2b",
  "outcome": "APPROVED",
  "autonomy_level": "L3",
  "checks": [
    { "name": "agent_auth", "result": "pass" },
    { "name": "rail_validation", "result": "pass", "detail": { "merchant_verified": "Shop A Electronics", "category": "electronics", "honeypot": false } },
    { "name": "mandate", "result": "pass" },
    { "name": "policy_licence", "result": "pass", "detail": { "effective_cap": 30000 } },
    { "name": "risk", "result": "pass", "signals": [] },
    { "name": "guardian", "result": "pass" }
  ],
  "risk_signals": [{ "type": "price_above_evidence", "score": 0, "action": "authorized" }],
  "user_explanation": "Headphones from a verified electronics shop, ¥279 within your ¥300 mandate, cheapest of 3 compared.",
  "created_at": "2026-10-13T14:22:05+08:00"
}
```

`outcome`: `APPROVED | STEP_UP | DENIED`.
`check.result`: `pass | step_up | deny | skipped`.

### Receipt (WeBank-signed)

```json
{
  "schema": "receipt.v1",
  "receipt_id": "rcp_77aa",
  "payment_id": "pay_1a2b",
  "decision_id": "dec_44b0",
  "mandate_id": "mdt_91c2",
  "merchant_id": "mch_shopA",
  "order_id": "ord_5521",
  "amount": { "amount": 27900, "currency": "CNY" },
  "outcome": "APPROVED",
  "chain": { "network": "base-sepolia", "payment_tx": "0x...", "audit_tx": "0x..." },
  "issued_at": "2026-10-13T14:22:07+08:00",
  "webank_sig": "b64..."
}
```

A DENIED receipt has no `payment_tx` but still has `audit_tx`.

### Approval (step-up card for the app)

```json
{
  "schema": "approval.v1",
  "approval_id": "apr_31cd",
  "kind": "payment",
  "subject_id": "pay_1a2b",
  "title": "Claude wants to pay ¥279",
  "lines": ["To: Shop A Electronics (verified)", "For: Sony WH-1000XM5 Black", "Why asking: Claude is on L-plates"],
  "payload_hash": "sha256:...",
  "expires_at": "2026-10-13T14:27:05+08:00",
  "status": "pending"
}
```

`kind`: `payment | mandate | pairing | policy_loosen | treasurer_schedule | emergency_topup | unfreeze`.
`status`: `pending | approved | rejected | expired`; expired = rejected.

### Commitment and funding proposal (Treasurer)

```json
{
  "schema": "commitment.v1",
  "commitment_id": "cmt_01",
  "payee_merchant_id": "mch_anthropic",
  "label": "Claude subscription",
  "amount": { "amount": 3000, "currency": "USD" },
  "frequency": "MONTHLY",
  "next_due": "2026-10-28",
  "source": "detected_from_settled",
  "status": "proposed"
}
```

```json
{
  "schema": "funding_proposal.v1",
  "proposal_id": "prp_09",
  "commitments": ["cmt_01"],
  "buffer_target": { "amount": 20000, "currency": "CNY" },
  "schedule": [{ "commitment_id": "cmt_01", "fund_at": "2026-10-27T21:00:00+08:00", "amount": { "amount": 3000, "currency": "USD" } }],
  "rationale": "Charged on the 28th for the last 3 months.",
  "status": "pending_user"
}
```

### Audit record

```json
{
  "schema": "audit.v1",
  "audit_id": "aud_0192",
  "kind": "payment_decision",
  "actor": "agt_7f3a",
  "subject_id": "dec_44b0",
  "summary": "APPROVED ¥279 to Shop A Electronics",
  "record_hash": "sha256:...",
  "chain_tx": "0x...",
  "created_at": "2026-10-13T14:22:06+08:00"
}
```

`kind`: `pairing | mandate | payment_decision | funding | freeze | licence_change | drill | policy_change | monitor_alert`.

## 2. Agent-facing API (Gateway)

Called only by the connector (MCP server), never by the LLM directly.

| Method + path | Purpose | Body -> Response |
|---|---|---|
| `POST /v1/oauth/device_authorization` | Start pairing (QR) | `{ client_name, provider, agent_public_key, requested_scopes }` -> `{ device_code, user_code, verification_uri, qr_payload, expires_in: 600, interval: 3 }` |
| `POST /v1/oauth/token` | Poll for pairing result | `{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code }` -> `{ access_token, refresh_token, expires_in: 900, agent_id }` or `{ error: "authorization_pending" \| "access_denied" \| "expired_token" }` |
| `POST /v1/oauth/token` (refresh) | Rotate tokens | `{ grant_type: "refresh_token", refresh_token }` -> new pair; old refresh token invalidated |
| `POST /v1/agent/mandates` | Propose a mandate | `{ description, constraints[] }` -> `201 { mandate }` (`active` if under auto threshold) or `202 { mandate, approval_id }` (`pending_user`) |
| `GET /v1/agent/mandates/{id}` | Mandate status | -> `{ mandate }` |
| `POST /v1/agent/payments` | Request a payment | `{ mandate_id, payment_request, cart_claim?, price_evidence[], rationale }` -> see below |
| `GET /v1/agent/payments/{id}` | Poll a STEP_UP | -> `{ payment_id, status, decision, receipt? }` |
| `GET /v1/agent/payments?limit=` | Own history | -> `{ items: [ { payment_id, status, amount, merchant, created_at } ] }` |

`POST /v1/agent/payments` responses:

| Status | Body | Meaning |
|---|---|---|
| `200` | `{ payment_id, status: "paid", decision, receipt }` | Approved and paid |
| `202` | `{ payment_id, status: "awaiting_user", decision, approval_id, poll_after: 3 }` | STEP_UP sent to the app |
| `403` | `{ payment_id, status: "denied", decision, receipt }` | Denied; reason in `decision.user_explanation` |
| `409` | `{ error: { code: "idempotency_conflict" \| "mandate_in_flight" } }` | Retry with care / one in flight |
| `401` | `{ error: { code: "bad_signature" \| "token_expired" \| "agent_frozen" } }` | Auth failed |

`price_evidence[]`: `[{ merchant_name, url?, price: Money, seen_at }]` (a claim; used only for the price sanity signal).

## 3. App-facing API (Gateway)

| Method + path | Purpose | Sensitive (WebAuthn)? |
|---|---|---|
| `POST /v1/app/webauthn/register` / `.../verify` | Register the phone's passkey | First time only |
| `GET /v1/app/home` | Main balance, agent wallet pots, alerts | No |
| `GET /v1/app/pairing/{user_code}` | Consent screen content (agent name, device, location, scopes, starting licence) | No |
| `POST /v1/app/pairing/{user_code}/approve` | Approve pairing | Yes |
| `POST /v1/app/pairing/{user_code}/deny` | Deny pairing | No |
| `GET /v1/app/agents` | Connected agents with licence | No |
| `POST /v1/app/agents/{id}/freeze` | Freeze one agent | No (tightening is instant) |
| `POST /v1/app/agents/{id}/unfreeze` | Unfreeze | Yes |
| `POST /v1/app/agents/{id}/revoke` | Revoke permanently | No |
| `POST /v1/app/freeze-all` | Freeze every agent + Treasurer | No |
| `GET /v1/app/policy` / `PUT /v1/app/policy` | Read / change limits; loosening needs WebAuthn | Loosen only |
| `GET /v1/app/mandates` / `POST /v1/app/mandates/{id}/cancel` | List / cancel mandates | No |
| `GET /v1/app/approvals?status=pending` | Pending cards | No |
| `POST /v1/app/approvals/{id}/decide` | `{ decision: "approve" \| "reject", webauthn_assertion? }` | Yes for approve |
| `GET /v1/app/events` | SSE stream (see section 8) | No |
| `GET /v1/app/payments` / `GET /v1/app/payments/{id}` | History with decision + receipt + chain links | No |
| `GET /v1/app/audit?kind=&agent_id=` | Audit log | No |
| `GET /v1/app/treasurer` | Commitments, schedule, pots, last proposals | No |
| `POST /v1/app/treasurer/proposals/{id}/decide` | Approve / reject a funding proposal | Yes for approve |
| `POST /v1/app/treasurer/toggle` | `{ enabled }`; disabling is instant, enabling needs WebAuthn | Enable only |
| `POST /v1/app/chat` | `{ message }` -> `{ reply, proposed_action? }`; a proposed action becomes an approval card, never executes | No |

## 4. Internal interfaces

### Guardian (gateway -> guardian)

```
evaluate(input) -> verdict
```

```json
{
  "mandate": { "description": "...", "user_text": "...", "constraints": [] },
  "merchant_verified": { "name": "Shop A Electronics", "category": "electronics", "first_seen": false },
  "signed_line_items": [],
  "untrusted": { "cart_claim": [], "rationale": "...", "price_evidence": [] },
  "risk_signals": []
}
```

```json
{ "verdict": "pass", "reasons": ["Item matches mandate category and description"], "user_explanation": "..." }
```

`verdict`: `pass | step_up | deny`.
Gateway merge rule: final = strictest of (deterministic result, guardian verdict).
Timeout 8s or refusal -> treated as `step_up`.

### Treasurer (scheduler -> treasurer)

```
propose(settled_transactions[], current_commitments[], policy) -> { commitments[], proposals[] }
```

Only bank-settled transactions are passed in; never agent or merchant text.
Output goes to the app as `treasurer_schedule` approval cards.

### Executor (deterministic)

```
fund(user_id, pot: "reserved" | "buffer", amount, reason_ref) -> chain tx
```

Allowed only if: schedule entry approved by the user, within ceilings, main balance stays above `protected_main_balance`, destination is the same user's agent wallet.

### Monitor (cron, every 60s)

Invariants; any violation freezes the Treasurer, raises an `monitor_alert` audit record and an app alert.

| Invariant |
|---|
| agent wallet reserved pot <= sum of approved commitments due in next 48h |
| agent wallet buffer pot <= buffer_target |
| top-ups today <= daily_topup_ceiling; this month <= monthly_topup_ceiling |
| main balance >= protected_main_balance after any top-up |
| no payment from reserved pot to a payee other than its commitment |
| every on-chain payment has a matching APPROVED decision |

## 5. Shop interfaces

### Shop MCP tools (for the agent)

| Tool | Input | Output |
|---|---|---|
| `search_products` | `{ query, max_price? }` | `[{ sku, name, price, rating, summary }]` |
| `get_product` | `{ sku }` | `{ sku, name, price, specs, sizes, colours, reviews[], description }` (description may contain injected text on the malicious shop) |
| `add_to_cart` | `{ sku, qty, options }` | `{ cart }` |
| `get_cart` | `{}` | `{ cart }` |
| `checkout` | `{ shipping_profile: "default" }` | `{ order_id, total, payment_request: "ecny://pay?d=...", expires_at }` |
| `get_order` | `{ order_id }` | `{ order_id, status: "awaiting_payment" \| "paid" \| "shipped", items }` |

### Shop HTTP (for humans and the rail)

| Method + path | Purpose |
|---|---|
| `GET /` , `/p/{sku}`, `/cart`, `/checkout` | Human storefront (checkout page shows the payment QR) |
| `POST /internal/payment-confirmed` | Rail notifies the shop: `{ order_id, payment_tx }` -> order becomes `paid` |
| `POST /admin/price` | Demo control: drop a price (Demo 3) |

## 6. WeBank connector MCP tools (installed into Claude)

| Tool | What it does | Notes |
|---|---|---|
| `connect_webank` | Starts pairing; returns a QR / code for the user to scan in the WeBank app | Polls token endpoint until approved |
| `create_mandate` | Proposes a mandate from the user's request | May return "awaiting approval in WeBank app" |
| `request_payment` | Sends the shop's payment request + evidence to WeBank | Returns paid / awaiting approval / denied + explanation |
| `get_payment_status` | Polls a pending approval | |
| `list_my_payments` | The agent's own history | No access to main account or balance |

The connector holds the agent private key and tokens in its process; tool results never include keys or tokens.

## 7. Smart contracts

| Contract | Key functions | Who may call |
|---|---|---|
| `ECnySim` (ERC-20 style) | `transfer`, `balanceOf` | Anyone (simulated e-CNY) |
| `MerchantRegistry` | `register(merchantId, payout, pubKey, category, isHoneypot)`, `get(merchantId)` | Admin registers; anyone reads |
| `AgentWallet` | `fund(user, pot, amount)`; `pay(user, pot, merchantId, amount, orderId, decisionId)`; `setCaps(user, perPayment, daily)`; `freeze(user)`, `unfreeze(user)` | `fund`: Executor only, capped. `pay`: Gateway only, capped, reverts if frozen or merchant is a honeypot. `setCaps`: lowering by Gateway; raising only with user signature. |
| `LicenceRegistry` | `setLicence(agentId, level, points)`, `get(agentId)` | Gateway writes; anyone reads (the public agent directory) |
| `AuditAnchor` | `anchor(bytes32 recordHash, uint8 kind)` emits `Anchored` | Gateway, Executor, Monitor |

Events: `Funded`, `Paid`, `Frozen`, `Unfrozen`, `CapsChanged`, `LicenceChanged`, `Anchored`.
Caps live in the contract so a compromised Gateway or Executor still cannot exceed them.

## 8. SSE events (`GET /v1/app/events`)

| Event | Data |
|---|---|
| `approval.created` | `{ approval }` |
| `approval.resolved` | `{ approval_id, status }` |
| `payment.completed` | `{ payment_id, outcome, amount, merchant, receipt_id }` |
| `payment.denied` | `{ payment_id, user_explanation }` |
| `agent.licence_changed` | `{ agent_id, from, to, reason }` |
| `agent.frozen` | `{ agent_id, reason: "user" \| "circuit_breaker" }` |
| `treasurer.funded` | `{ pot, amount, commitment_id? }` |
| `monitor.alert` | `{ invariant, detail }` |
| `drill.result` | `{ agent_id, passed, points }` |

## 9. Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `bad_signature` | 401 | RFC 9421 signature invalid, expired, or nonce reused |
| `token_expired` | 401 | Refresh needed |
| `agent_frozen` | 401 | Agent frozen or revoked |
| `scope_missing` | 403 | Token lacks the scope |
| `mandate_not_found` / `mandate_expired` / `mandate_exhausted` | 403 | Mandate unusable |
| `mandate_in_flight` | 409 | Another payment on this mandate is pending |
| `payreq_invalid` | 400 | Payment request signature, expiry, or format invalid |
| `merchant_unknown` | 403 | Merchant not in registry |
| `idempotency_conflict` | 409 | Same key, different body |
| `policy_denied` | 403 | Blocked by limits, category, or licence |
| `guardian_denied` | 403 | Guardian intent check failed |
| `rate_limited` | 429 | Too many requests |

## 10. One purchase, by endpoint

1. Claude -> shop MCP `checkout` -> `payment_request`.
2. Claude -> connector `request_payment` -> `POST /v1/agent/payments` (signed, idempotent).
3. Gateway: verify signature -> verify `merchant_sig` via `MerchantRegistry` -> mandate -> policy + licence -> risk -> Guardian -> decision.
4. If STEP_UP: `approval.created` over SSE -> user approves with WebAuthn -> `POST /v1/app/approvals/{id}/decide`.
5. Gateway -> `AgentWallet.pay(...)` -> `Paid` event -> shop `POST /internal/payment-confirmed`.
6. Gateway signs receipt -> `AuditAnchor.anchor(hash)` -> `payment.completed` over SSE -> connector returns receipt to Claude.
