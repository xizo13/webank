# Tech Stack

Status: draft for team review.
Last updated: 2026-10-13.

Guiding rule: one language end to end, one shared contract package, every component replaceable.

## 1. Summary

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One language and shared types: agents and teammates build against the same contracts with no translation bugs between services |
| Repo | pnpm workspaces monorepo | One clone, one install, shared `contracts` package |
| Contract | `packages/contracts`: zod schemas for every request, response, event | The single source of truth; types and runtime validation from one definition |
| Gateway + Treasurer + Monitor | Node 22, Fastify, Drizzle ORM, Postgres 16 | Fastify is fast and schema-first; Postgres is standard and robust; Drizzle keeps SQL typed |
| Real-time to app | Server-Sent Events (SSE) | Approval cards and notifications push to the phone; simpler than WebSockets |
| AI (Guardian, Treasurer, in-app chat) | Claude API via `@anthropic-ai/sdk`, model `claude-opus-5-5`, structured outputs (zod schema via `messages.parse`) | Structured verdicts are validated, not parsed from prose; one model, effort tuned per job |
| Biometric approval | WebAuthn passkeys (`@simplewebauthn/server` + `/browser`) | Real Face ID / Touch ID on the phone; the approval is a cryptographic signature, not a button |
| WeBank app | React + Vite + Tailwind, mobile-first PWA | Opens on a real phone over LAN or tunnel; looks like a banking app |
| Mock shops | Next.js (one codebase, 3 configs: Shop A, Shop B, Malicious) + a shop MCP server | Human UI for the video, MCP tools for the agent |
| WeBank connector (agent side) | MCP server (TypeScript MCP SDK), stdio for Claude Desktop / Claude Code | Holds the agent key in deterministic code; the LLM only sees tool results |
| Agent request signing | RFC 9421 HTTP Message Signatures, Ed25519 | Standard, replay-safe; same as Visa/Mastercard agent auth |
| Chain | Solidity 0.8 contracts, Foundry (build + test), viem (TS client) | Works on FISCO BCOS (Solidity-compatible) and any EVM testnet |
| Chain target | FISCO BCOS if someone has used it; otherwise Base Sepolia testnet | Sponsor fit vs. speed; contracts are identical either way |
| Doubao (stretch) | Small Node wrapper: Volcengine Ark API with function calling, reusing the connector's tool definitions | Shows a Chinese model works; zero changes to the Gateway |
| Local run | docker compose (Postgres + Gateway + app + shops) + `anvil` for local chain | "One command" deployment instruction for the submission |
| Tests | Vitest (TS), Foundry tests (contracts), red-team suite as Vitest scenarios | Red-team tests double as the known-risk evidence |

## 2. Repository layout

```
webank-agent-wallet/
  packages/
    contracts/        zod schemas + TS types: the API contract (owned jointly; changes need team review)
    crypto/           RFC 9421 sign/verify, Ed25519 keys, hashing helpers
    chain/            viem client + generated contract ABIs
  services/
    gateway/          Fastify: OAuth device flow, mandates, payments, 7 checks, licence, receipts, audit
    guardian/         Guardian AI module (called by gateway, never exposed publicly)
    treasurer/        Treasurer AI (proposals) + executor (scheduled transfers)
    monitor/          Invariant watchdog (cron): balances, ceilings, freezes Treasurer on violation
  apps/
    webank-app/       React PWA: home, Agent Wallet, consent, approvals, agents, history, chat, freeze
    shops/            Next.js storefronts + shop MCP server
  agents/
    connector-mcp/    WeBank MCP server installed into Claude
    doubao-wrapper/   Stretch: Doubao Open API + same tools
  onchain/
    src/              AgentWallet.sol, MerchantRegistry.sol, LicenceRegistry.sol, AuditAnchor.sol, ECnySim.sol
    test/
  redteam/            Attack scenarios with expected outcomes
  docs/               Architecture, security self-assessment, deployment
  docker-compose.yml
```

## 3. How the agent reaches the shop

| Option | How | Verdict |
|---|---|---|
| Shop MCP tools | Shop exposes `search_products`, `get_product`, `add_to_cart`, `checkout` | Primary: reliable, repeatable demo; the injected text lives in product data returned by the tools, which is realistic |
| Browser use | Claude drives the shop's web UI | Stretch: impressive but flaky on stage |

The human-facing shop UI still exists for the video and for showing the order page.

## 4. AI components

All three use `claude-opus-5-5` with structured outputs; effort is set per job.

| Component | Job | Effort | Output schema | If it fails or times out |
|---|---|---|---|---|
| Guardian | Judge one payment against the mandate's intent | low (latency matters) | `{verdict: pass \| step_up \| deny, reasons[], user_explanation}` | Fail closed: STEP_UP to the user, never APPROVE |
| Treasurer | Find recurring commitments in settled history; propose schedule and buffer | medium | `{commitments[], buffer_target, proposals[]}` | No proposal; nothing moves; manual funding still works |
| In-app chat | Answer questions; propose limit changes | medium | `{reply, proposed_action?}` | Reply with an error; never acts |

Rules that apply to all three:

- They never hold keys or call money-moving functions; they return JSON to deterministic code.
- Their outputs can only tighten decisions (Guardian) or create proposals that a non-AI screen + Face ID must confirm (Treasurer, chat).
- Handle `stop_reason: "refusal"` and enable the server-side fallback parameter; a refusal is treated as a failure (fail closed).
- Inputs from merchants and agents are wrapped and labelled as untrusted data in the prompt.

## 5. Decisions to confirm with the team

1. TypeScript for everything (recommended) or split languages by owner.
2. Chain: decided by a scoped spike (section 6).
3. Shop access: MCP tools first, browser use as stretch (recommended).
4. Hosting for the demo: local machine + tunnel (recommended) vs. cloud.

## 6. Chain decision: FISCO BCOS vs. Base Sepolia

Assumption: nobody on the team has used either.

### What the chain does in our design

The chain is not there for crypto; it is there so the bank's own servers cannot quietly break the rules.

| Use | Why it needs a chain (not just our database) |
|---|---|
| Hard caps in the AgentWallet contract | Even a hacked Gateway or Treasurer cannot exceed them |
| Simulated e-CNY settlement | Payments produce real tx hashes (required execution evidence for Topic F) |
| Merchant registry | Merchant identity comes from shared infrastructure, not a web page |
| Licence registry | A public directory any bank or merchant can check before trusting an agent |
| Audit anchors | Every decision, including denials, is tamper-evident |

### The two options

| | FISCO BCOS | Base Sepolia |
|---|---|---|
| What it is | Open-source permissioned (consortium) blockchain started by WeBank and partners in Shenzhen; nodes run by known, licensed institutions | Public test network of Base, Coinbase's Ethereum layer 2; free test tokens |
| Fit with the sponsor | Very high: WeBank's own technology | Low; and Base is the chain behind Coinbase's x402 agent payments, which is a plus for the agent-payment story |
| Fit with China | Matches how China deploys blockchain in finance: permissioned, known participants, Chinese national cryptography (SM2/SM3) supported | Public crypto chains are not used for consumer payments in mainland China |
| Privacy | Data stays on the consortium's nodes | Everything on-chain is public (we only put hashes and test amounts there) |
| Contracts | Solidity supported | Solidity (native) |
| Tooling with our TypeScript stack | Java SDK is the primary SDK; its RPC is not Ethereum's by default (check whether the 3.x Ethereum-compatible RPC works with viem); WeBASE gives a web console and explorer | Works directly with viem, Foundry, every tutorial; AI coding tools know it very well |
| Running it | We run our own nodes (build script or Docker) | Nothing to run; use a public RPC |
| Proving tx hashes to judges | Only visible on our own chain: show via WeBASE explorer / screenshots | Anyone can open the hash on the public explorer |
| Docs and community | Smaller; much of it in Chinese | Very large, English |
| Delivery risk | Higher: unfamiliar setup, SDK mismatch, chain ops agents cannot fully script | Low |

### What each choice says about us

- FISCO BCOS: "We designed this the way WeBank would actually deploy it."
  We prioritize sponsor and regulatory fit; we accept setup risk and less public verifiability.
- Base Sepolia: "We prioritized a working, publicly verifiable demo."
  We prioritize delivery and transparency; we accept a public-crypto association and a weaker China story.

### Decision rule (recommended)

1. Write contracts in plain Solidity with no chain-specific features; all chain calls go through one adapter in `packages/chain`.
2. First: an agent runs the FISCO BCOS spike (spike-fisco-brief.md): start a local chain, deploy the test contracts, call them from TypeScript; it stops early if the basics fail.
3. If the spike works: FISCO BCOS is the main chain.
   If it does not: Base Sepolia is the main chain, and the deck names FISCO BCOS as the production target with the same contracts.
4. Either way, develop and test against a local EVM (`anvil`) so nobody waits on the chain.

## 7. What the stack says we prioritized, and what we gave up

### Prioritized

| Priority | Where it shows in the stack |
|---|---|
| Safety by construction, not by AI | AI components only return JSON to deterministic code; caps live in contracts; approvals are WebAuthn signatures |
| Fail closed | Guardian timeout or refusal becomes "ask the user"; Monitor freezes the Treasurer on any invariant breach |
| Verifiability | Signed receipts, on-chain audit anchors, tx hashes for every payment and denial |
| Standards over invention | OAuth device flow, RFC 9421 signatures, WebAuthn, MCP, AP2-shaped mandates |
| Real where it matters | Real biometric (passkeys), real AI decisions, real contracts, real signatures |
| Demo reliability | Shop MCP tools instead of browser automation; local stack with docker compose |
| Team speed | One language, one contract package, independent services built against agreed schemas |

### Sacrificed (and how we will say it)

| Given up | Why | How we present it |
|---|---|---|
| Full AP2 SD-JWT credential encoding | Too heavy for hackathon scope | Same fields and hash bindings; "AP2-aligned, full encoding is future work" |
| More than one payment rail | Time | Only the e-CNY sub-wallet is built; WeChat Pay and cards shown as adapters in the architecture |
| Real e-CNY | Not accessible to students | Simulated token with the same sub-wallet rules |
| Browser-based shopping | Flaky on stage | Shop MCP tools; browser use as stretch |
| Doubao support | Account and time risk | Stretch goal with the same tools |
| Native mobile app | Time | PWA on a real phone, real Face ID via passkeys |
| Production key management (HSM), scaling, multi-region | Out of scope for a prototype | Listed in the security self-assessment as known gaps |
| Privacy of a public chain (if Base Sepolia) | Delivery risk of FISCO | Only hashes and test amounts on-chain; production target is permissioned |
