# Task Plan - Priority, Workload, Autonomy

Status: draft.
Last updated: 2026-10-13.

No time estimates: building is done by agents and sub-agents.
Each task is rated on three things instead.

| Label | Meaning |
|---|---|
| Priority | High: the demo or submission fails without it. Med: scores points. Low: stretch. |
| Workload | High / Med / Low: how much there is to build or produce, not how long it takes |
| Autonomy A | Agent-autonomous: the spec and tests are enough; the human only checks the result passes |
| Autonomy B | Agent builds, human reviews: security-critical logic, judgment calls, or visible UX |
| Autonomy C | Human-led: decisions, accounts and credentials, real-device testing, people, presenting |

Why some tasks cannot be A: anything that defines what "safe" means, anything judges see, and anything needing a human identity (accounts, API keys, biometrics, sending messages) stays with a human.

## Wave 0 - Unblock everything

Everything else builds against these.

| # | Task | Priority | Workload | Autonomy | Notes |
|---|---|---|---|---|---|
| 0.1 | Close open decisions: auto-approve threshold, Guardian input, licence thresholds, live vs video | High | Low | C | Recommendations in README "Still to decide" |
| 0.2 | Registration, eligibility (60% non-Chinese nationals), organizer follow-up | High | Low | C | |
| 0.3 | Accounts and keys: Anthropic API key, testnet faucet or FISCO setup, GitHub repo | High | Low | C | Agents must not create accounts or handle real credentials |
| 0.4 | FISCO BCOS spike | High | Med | A | Dispatch spike-fisco-brief.md; human reads the verdict |
| 0.5 | `packages/contracts`: zod schemas from api-contracts.md | High | Med | B | The agreement between all lanes; whole team reviews before anyone builds on it |
| 0.6 | Monorepo scaffold, docker compose, CI (lint + tests) | High | Low | A | |

## Wave 1 - Build in parallel (four lanes)

### Lane 1: Gateway + Guardian (the core)

| # | Task | Priority | Workload | Autonomy | Notes |
|---|---|---|---|---|---|
| 1.1 | OAuth device flow + QR pairing | High | Med | B | Security-critical |
| 1.2 | RFC 9421 request signing/verification, nonce cache, idempotency | High | Med | B | Security-critical; agent writes tests from the spec |
| 1.3 | Decision pipeline: 7 checks, strictest-wins merge, fail closed | High | High | B | Heart of the product; human reviews every rule against protocol.md |
| 1.4 | Guardian: prompt, structured output, untrusted-input wrapping | High | Med | B | Human judges its behavior on the red-team cases |
| 1.5 | Receipts (signed) + audit records + SSE events | High | Med | A | |
| 1.6 | Licence engine + fire-drill scheduler | Med | Med | A | Rules fully specified in brainstorm.md section 12; human tunes thresholds (0.1) |

### Lane 2: Chain + Treasurer

| # | Task | Priority | Workload | Autonomy | Notes |
|---|---|---|---|---|---|
| 2.1 | Contracts: ECnySim, MerchantRegistry, AgentWallet, LicenceRegistry, AuditAnchor + Foundry tests | High | Med | B | Caps live here; human reviews every `require` and test |
| 2.2 | `packages/chain` adapter (viem or FISCO SDK per spike) | High | Low | A | |
| 2.3 | Treasurer AI: recurring detection, proposals | Med | Med | B | Human checks proposals make sense on mock history |
| 2.4 | Executor + Monitor (6 invariants, auto-freeze) | Med | Med | B | Security-critical; rogue-Treasurer defense |
| 2.5 | Mock transaction history and seed data | Med | Low | A | |

### Lane 3: WeBank app + shops (what judges see)

| # | Task | Priority | Workload | Autonomy | Notes |
|---|---|---|---|---|---|
| 3.1 | App screens: home, Agent Wallet setup, limits, consent, approval card, connected agents + licence, history, Treasurer, chat, freeze | High | High | B | Visible to judges; human owns pixel-level polish |
| 3.2 | WebAuthn passkeys (register + sign approvals) | High | Med | B + C | Agent builds; a human must test on a real phone |
| 3.3 | Shops: storefront UI, cart, checkout with signed payment request + QR | High | Med | A | |
| 3.4 | Shop MCP tools | High | Low | A | |
| 3.5 | Malicious listing + fire-drill decoy content | High | Low | B | Human chooses attacks that look convincing on stage |
| 3.6 | Demo controls: price drop, fast-forward clock, reset | Med | Low | A | |

### Lane 4: Agent connector + security evidence

| # | Task | Priority | Workload | Autonomy | Notes |
|---|---|---|---|---|---|
| 4.1 | WeBank connector MCP (holds agent key; 5 tools) | High | Med | A | |
| 4.2 | Red-team suite: each attack in standards.md and protocol.md as an automated test with expected outcome | High | Med | A (tests) + B (attack list) | Doubles as test cases and known-risk evidence |
| 4.3 | Scripted fallback agent for a repeatable demo | Med | Low | A | Backup if live Claude misbehaves |
| 4.4 | Doubao wrapper | Low | Med | A + C | Volcengine account and verification are human tasks |

## Wave 2 - Integrate and verify

| # | Task | Priority | Workload | Autonomy | Notes |
|---|---|---|---|---|---|
| 5.1 | End-to-end runs of all six demo flows | High | Med | B | Agent runs automated E2E; human runs it on a real phone with real Claude |
| 5.2 | Fix integration bugs found in 5.1 | High | Med | A | Reproduce end to end first, then fix |
| 5.3 | Survey analysis: tag replies, count, pick quotes | Med | Low | A | Sending the survey is C |

## Wave 3 - Submission deliverables

| # | Task | Priority | Workload | Autonomy | Notes |
|---|---|---|---|---|---|
| 6.1 | Technical documentation (architecture, core algorithm, security design) | High | Med | B | Agent drafts from the docs in this folder; human edits |
| 6.2 | Security self-assessment (permission tiers + known-risk list) | High | Med | B | Built from standards.md section 6 + red-team results |
| 6.3 | README, deployment instructions, test cases in the repo | High | Low | A | |
| 6.4 | Execution evidence: sandbox logs + tx hashes | High | Low | A | Exported from audit log and chain |
| 6.5 | Pitch deck (max 10 min) | High | Med | C (story) + B (slides) | Humans own the narrative; agent builds slides |
| 6.6 | Demo video (max 5 min) | High | Med | C | Humans record; agent writes the shot script (A) |
| 6.7 | Final submission and GitHub link | High | Low | C | |

## Critical path

0.5 contracts package -> 1.3 decision pipeline + 2.1 contracts + 3.1 app + 4.1 connector -> 5.1 end-to-end -> 6.5 deck + 6.6 video.
If the contracts package is wrong, every lane builds the wrong thing; that is why it is the one Wave 0 task the whole team reviews.

## Human oversight hotspots

The places a human must look closely, because an agent getting them subtly wrong breaks the safety story:

1. Decision pipeline rules and the strictest-wins merge (1.3).
2. Contract `require` checks and caps (2.1).
3. Monitor invariants (2.4).
4. Guardian behavior on attack cases (1.4, 4.2).
5. Anything shown on screen to judges (3.1, 6.5, 6.6).
