# Security Standards Review - What We Adopt and Why

Status: draft.
Last updated: 2026-10-13.

Rule for this document: every feature we adopt states its purpose.
If we cannot state the purpose, we do not build it.

## 1. Standards reviewed

| Standard | Owner | Layer | Open source? |
|---|---|---|---|
| AP2 (Agent Payments Protocol) v0.2 | Google + 60 partners | Authorization: proves what the user approved | Yes, Apache-2.0 (spec, Python SDK, JSON schemas, samples) |
| Delegated Payment Spec (part of ACP) | OpenAI + Stripe | Credential handoff from agent platform to merchant | Spec is open; Stripe SPT is the reference implementation |
| Trusted Agent Protocol / Agent Pay | Visa / Mastercard (via Web Bot Auth) | Agent identity on every HTTP request | Built on open IETF work (RFC 9421) |
| MCP Authorization | Model Context Protocol | How an agent tool authorizes against a server | Yes |
| OWASP Top 10 for Agentic Applications (2026) | OWASP | Threat catalogue for agents | Yes |
| UnionPay APOP | China UnionPay | Bank-side agent payment framework (China) | Invite-only sandbox |
| PCAC Agent Payment Self-Regulatory Convention | PCAC, guided by PBOC | Regulatory requirements (China) | Public convention |

## 2. AP2 in one page

### Roles

| AP2 role | Job | Who plays it in our design |
|---|---|---|
| Shopping Agent | Discovers products, builds the checkout, executes the purchase | The user's agent (Claude, ChatGPT) |
| Credential Provider | Checks the agent is allowed to use the payment credential; scopes it | WeBank Agent Gateway |
| Trusted Surface | Non-AI UI that shows the user what they approve and gets consent | WeBank app approval screens |
| Merchant | Provides and completes the checkout; guarantees price and inventory | Mock shops |
| Merchant Payment Processor | Checks the credential is authorized for this exact checkout | Rail (e-CNY sub-wallet contract) |

Takeaway: our design already matches AP2's role split.
WeBank naturally plays two roles: Credential Provider and Trusted Surface.

### Core principles (and why)

1. "Preventing prompt injection attacks is infeasible", so every LLM is treated as a potential attacker.
   Why: you cannot make the agent safe, so you bound the damage instead.
2. The Trusted Surface MUST be non-agentic (no LLM).
   Why: if an LLM sits in the approval path, injected text could make it "approve".
3. All verification MUST run in deterministic code, even inside an agentic role.
   Why: LLM output is not reproducible or auditable.
4. Even if the LLM picks badly, constraint checks keep "the worst-case financial and logical impacts strictly bounded".
   Why: safety comes from limits, not from the AI being smart.

### Two modes

| Mode | User approves | Who signs the final purchase |
|---|---|---|
| Human Present | The exact cart and payment | The user, on the Trusted Surface |
| Human Not Present | A set of constraints ("open mandate") | The agent's key, inside the user's constraints |

If an autonomous purchase does not fit the constraints, the verifier returns `unresolved_constraint` and the user is brought back in.
This is exactly our STEP_UP.

### Mandate constraint types

| Constraint | Meaning |
|---|---|
| Amount range | Payment must be between min and max |
| Budget | Total spend across repeated uses |
| Agent recurrence | How often and how many times the mandate can be reused (e.g. monthly, max 12) |
| Allowed payees | Only these merchants |
| Allowed payment instruments | Only these funding sources |
| Execution date | Only within this time window |
| Allowed merchants / line items (checkout) | What may be bought, from whom |

### AP2 threat model (threat -> mitigation)

| Threat | AP2 mitigation |
|---|---|
| Stolen payment approval reused for a different cart | Payment mandate is hash-bound to one specific checkout |
| One open mandate reused to approve many purchases (double spend) | Agent must not present a new closed mandate until the previous one is rejected; providers may reject overlaps |
| Open mandate stolen by another agent | Open mandate contains the agent's public key; only that agent can use it |
| Payment credential stolen after release | Credential released only after a verified final mandate; bound to that transaction |
| Prompt injection makes the agent pick a malicious product | Merchant signs the offer; constraint checks bound the worst case |
| Mandate leaks the user's wider intent | Selective disclosure: only the constraints relevant to this purchase are shown |

## 3. Other standards in brief

### Delegated Payment Spec (OpenAI / Stripe)

- Single-use token (`reason: one_time`).
- `max_amount` and `expires_at` on every token.
- Token bound to one `checkout_session_id` and one `merchant_id`.
- `Idempotency-Key` header; same key with different parameters returns 409 conflict.
- Signed request body plus timestamp.
- Risk signals passed along: `type`, `score`, `action` (blocked / manual_review / authorized).
- Prefer network tokens over real card numbers.

### Visa TAP / Mastercard Agent Pay (Web Bot Auth)

- Every agent request carries an HTTP Message Signature (RFC 9421) over method, path and key headers.
- `created` and `expires` define a short validity window; a `nonce` cache blocks replays inside it.
- `keyid` points to the agent's public key in a well-known directory hosted by the network.
- Tags separate browsing from paying (`agent-browser-auth` vs `agent-payer-auth`).
- Why: user agent strings and IP addresses can be spoofed; a signature cannot.

### MCP Authorization

- OAuth 2.1 with PKCE.
- Tokens are audience-bound to one server (resource indicators, RFC 8707).
- No token passthrough: a server must never forward a client's token upstream (confused deputy).
- Short-lived access tokens, rotating refresh tokens.

### OWASP Top 10 for Agentic Applications (2026)

Risk families include goal hijacking, tool misuse, privilege abuse, memory poisoning, cascading failures and rogue agents.
Several are mitigated directly by agent identity and cryptographic trust.
We use this list as the skeleton of our security self-assessment report.
(Check exact ASI01-ASI10 names against the official OWASP publication before submission.)

### UnionPay APOP (China)

Four capabilities: agent identity management, intent management, user identity management, payment authorization management.
Our design maps one-to-one, which lets us say "APOP-compatible".

### PCAC Convention (China, Aug 2026)

- Know Your Agent with tiered risk management based on agent model and behavior.
- Clear authorization boundaries.
- A signed responsibility agreement with the user.
- Strict verification of user identity and transaction intent.
- Clearing stays with licensed institutions; banks remain responsible.

## 4. What we adopt (feature -> purpose -> source)

### A. Already in our design (confirmed by standards)

| Feature | Purpose | Source |
|---|---|---|
| Mandates with amount cap, category, expiry, max payments | Bound the worst case of any purchase | AP2 constraints |
| STEP_UP when a payment does not fit | Bring the human back only when needed | AP2 `unresolved_constraint` |
| Agent key pair, signed requests | Prove which agent is asking; stolen tokens alone are useless | AP2 `cnf`, Web Bot Auth |
| Merchant identity from the rail, not the page | Pages can lie; the rail registry cannot | AP2 merchant signature principle |
| Reserved budget per mandate | Prevent double spend | AP2 double-spend rule |
| Idempotency key | Retries never pay twice | Delegated Payment Spec |
| Kill switch, mandate list, notifications | Keep the user in control even during autonomous runs | AP2 mandate management |
| Know Your Agent + licence tiers | Tiered risk by agent behavior | PCAC convention |

### B. New features to add

| # | Feature | Purpose | Source |
|---|---|---|---|
| 1 | The approval screen and limit changes are non-AI; chat can only propose, a deterministic screen + Face ID confirms | An injected LLM in the approval path could fake consent | AP2 Trusted Surface MUST be non-agentic |
| 2 | Agent's private key lives in the wallet connector (deterministic code), never in the LLM's context | The LLM cannot leak or misuse a key it never sees | AP2 implementation guidance (agent key via tool calling) |
| 3 | Mandate bound to the agent's public key | A mandate stolen by another agent is useless | AP2 `cnf` claim |
| 4 | One in-flight payment per mandate | Stop an injected agent firing many payments at once | AP2 double-spend rule |
| 5 | Merchant-signed checkout where available; otherwise the cart is treated as an unverified claim | The agent's own cart description can be a lie; only merchant-signed or rail-verified data is trusted | AP2 checkout JWT |
| 6 | Request signatures per RFC 9421 with `created`, `expires`, `nonce` | Replay protection with a standard, auditable format | Web Bot Auth / Visa TAP |
| 7 | Separate scopes for browsing vs paying | An agent that only browses cannot pay | Visa TAP tags |
| 8 | Tokens audience-bound to the WeBank Gateway; no token passthrough | Prevent confused-deputy attacks through the connector | MCP Authorization |
| 9 | Short-lived access tokens, rotating refresh tokens | Limit the window of a leaked token | MCP Authorization |
| 10 | WeBank-signed receipts for every decision, returned to agent and user | Non-repudiable dispute evidence | AP2 receipts |
| 11 | Dispute bundle: mandate + payment request + decision + receipt + chain hash | One package proves what the user approved and what happened | AP2 dispute evidence |
| 12 | Selective disclosure: merchant never learns the user's limits; guardian sees only what it needs | Data minimization (also PIPL) | AP2 privacy |
| 13 | Standing mandates via recurrence + budget (e.g. weekly groceries, max 4 times, ¥800 total) | Real autonomy for repeat tasks without unlimited power | AP2 agent recurrence + budget |
| 14 | Mandate expiry set to the shortest time that completes the task | Shrink the attack window | AP2 `exp` recommendation |
| 15 | Risk signal object (`type`, `score`, `action`) on every decision | Machine-readable reasons for merchants, rails and audits | Delegated Payment Spec |
| 16 | Versioned schemas (`mandate.v1`) | Upgrade safely without breaking old mandates | AP2 `vct` versioning |
| 17 | Agent licence directory (public key + licence level), mirrored on-chain | Any merchant or bank can check an agent before trusting it | Visa/Mastercard key directories + China's draft blockchain agent identity standard |
| 18 | User responsibility agreement shown at enrollment | Clear liability and boundaries, as the convention requires | PCAC convention |
| 19 | WeBank refund guarantee for L3 (auto-approved) payments later proven fraudulent | If the bank approved it alone, the bank carries the risk; builds trust | Ant AMP loss compensation, liability logic |

### C. Deliberately not adopted (for the hackathon)

| Item | Why not now |
|---|---|
| Full SD-JWT / Verifiable Credential encoding of mandates | Heavy for hackathon scope; we keep the same fields and hash bindings in plain signed JSON and note AP2 compatibility as future work |
| OpenID4VP credential presentation | Only needed when many external verifiers are involved |
| Card network tokens | Our rail is e-CNY simulated on-chain |
| Agent-to-agent delegation | Out of scope in AP2 too |

## 5. Open-source we can reuse

| Component | Use |
|---|---|
| AP2 repo (Apache-2.0): JSON schemas, Python SDK, samples | Mandate field names and constraint types; cite compatibility |
| MCP SDK | The wallet connector that agents plug into |
| HTTP Message Signatures libraries (RFC 9421) | Agent request signing and verification |
| OAuth 2.1 / device flow libraries | Agent enrollment |
| OpenZeppelin contracts (if on an EVM testnet) or FISCO BCOS Solidity | Sub-wallet, caps, pausable kill switch, licence registry |

Check each library's license before use; the submission must list third-party components.

## 6. How this shapes the security self-assessment report

The report the organizers require has two parts.

1. Permission-tier implementation: L0-L3 autonomy, licence levels, scopes, the non-AI Trusted Surface rule.
2. Known-risk list: AP2 threat table + OWASP agentic families + our own threats (fire drills, device-code phishing, closed agent platforms), each with mitigation and residual risk.
