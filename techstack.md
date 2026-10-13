# Tech Stack

Status: draft for team review.
Last updated: 2026-10-13.

Guiding rule: one language end to end, one shared contract package, every component replaceable.

## 1. Summary

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | 4 people, 7 days: one language, shared types, no translation bugs between services |
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
2. Chain: FISCO BCOS vs. Base Sepolia (ask who has used either).
3. Shop access: MCP tools first, browser use as stretch (recommended).
4. Hosting for the demo: local machine + tunnel (recommended) vs. cloud.
