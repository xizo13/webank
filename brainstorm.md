# WeBank Fintechathon - International Track Brainstorm

Status: design phase, no code yet.
Last updated: 2026-10-13.

## 1. Hackathon facts

- Theme: "AI as a Financial Participant" - each team builds an AI agent that completes real tasks in a financial scenario.
- Deadline: registration and submission both close Oct 20, 2026, 23:59 Beijing time (UTC+8).
- Team: 2-5 students from overseas universities; at least 60% non-Chinese nationals (3 of 4 for us).
- Language: English for everything.
- Finals: Shenzhen, Nov 21-23; at least one member must attend in person.
- Prize pool: RMB 250,000; top teams get fast-track WeBank interviews.

### Scoring

| Criterion | Weight |
|---|---|
| Task completion | 40% |
| Security & compliance | 30% |
| Innovation & interaction | 30% |
| On-chain challenge bonus | +0-5 |

### Submission checklist

1. Technical documentation (architecture, core algorithm, security design).
2. Presentation deck (max 10 min).
3. Demo video (optional, max 5 min).
4. Source code (README, GitHub link, deployment instructions, test cases).
5. Security self-assessment report (permission-tier implementation + known-risk list).
6. Execution evidence (sandbox logs for non-on-chain topics; real tx hashes for Topic F).

### Organizer answers

- The on-chain bonus is not tied to a topic; any topic can earn it.
- There is no restriction on Topic F.
- Still worth confirming: are testnet or self-deployed FISCO BCOS tx hashes accepted as execution evidence?

## 2. Decision trail

- Started with Topic C (cross-border student finance) + F hybrid.
- Interviewed a Chinese student in Singapore: remittance is solved by the parent via BOC China to BOC Singapore, same day, low fee.
- Conclusion: remittance is not a student-side pain for this segment; mainland crypto ban also blocks a stablecoin rail.
- Pivoted to an agentic wallet for agentic commerce (Topic F).
- Rejected "copy Western players for China" because Alipay and WeChat Pay already dominate agent payments there.
- Current direction: WeBank as the issuing bank and control layer behind whatever rail the merchant already accepts.

## 3. Core problem

How do you give an AI agent spending power without giving it the power to ruin you?

Today it is all-or-nothing:

- Give the agent your card or wallet: full power, one trick away from disaster.
- Approve every step: safe, but it is no longer an agent.

Risks in between:

1. The agent gets tricked (prompt injection from web pages, fake invoices).
2. The agent makes mistakes (wrong item, wrong quantity, hallucinated prices).
3. Payments are hard or impossible to reverse.
4. No accountability: who authorized what, and why?

Our answer is the middle ground: like a temporary spending card (Revolut style) for an AI, with limits enforced by the bank, not by the prompt.

## 4. Landscape (as of Oct 2026)

### Global

| Player | Layer | What it does |
|---|---|---|
| Google AP2 | Protocol | Signed mandates (intent, cart, payment) that make agent purchases provable; rail-agnostic; 60+ partners |
| Visa Intelligent Commerce | Card network | Agent-aware tokens, per-transaction trust score, directory of verified agents and merchants |
| Mastercard Agent Pay | Card network | One Agentic Token per agent, network-enforced caps and categories, revoke one agent without touching the card |
| OpenAI + Stripe ACP | Merchant side | Instant Checkout in ChatGPT; Shared Payment Token scoped to one merchant and cart total; merchant must integrate |
| Coinbase x402 | Protocol / crypto | HTTP 402 stablecoin payments for agents; micropayments; spend controls in SDK |

### China

| Player | What it does |
|---|---|
| Alipay AI Pay | Agentic Commerce Trust Protocol (Jan 2026); Qwen app shops Taobao/Tmall; single-use delegated purchases with identity check (May 2026); reported 120M agent tx in one week |
| WeChat Pay AI Dedicated Card | Launched Jun 2026; isolated card only agents spend from; user-set in/out limits; every payment needs phone confirmation; works with WorkBuddy, DeepSeek Harness, OpenClaw |
| Tencent Yuanbao + JD | Intent understanding + JD catalog; user still checks out manually |
| ByteDance Doubao | "One-sentence shopping" beta via Douyin; caught fabricating a cross-platform price comparison |
| UnionPay APOP | Bank-side agent payment open protocol (Apr 2, 2026); agent identity, intent management, user identity, payment authorization; 19 partners incl. commercial banks; invite-only sandbox; WeBank not named |
| Ant International AMP network | Launched Oct 8, 2026 in Shanghai; one protocol for 10 e-wallets + 7 acquirers; cross-recognized agent identity; 100% loss compensation; WeBank not named |
| Alipay AI wallet agent | Announced Sept 2026 (Bund Summit), not yet launched; links user intent and budget to agent steps; pre-payment risk check that the transaction matches what was authorized |

### WeBank's own work (checked 2026-10-13)

- No public WeBank product or announcement found on agent payments or agent wallets.
- Not named in UnionPay APOP or Ant AMP partner coverage.
- Caveat: WeBank's technology service page renders by JavaScript and could not be read automatically; internal projects are unknown.

### Standards

- Jul 2026: seven-part national standard series "Artificial Intelligence - Agent Interconnection" released.
- In initiation: guidance on agent identity management using blockchain / distributed ledger technology, led by the China Electronics Standardization Institute.

### Regulation

- PCAC "Self-Regulatory Convention for Agent Payment Applications" (Aug 24, 2026), guided by PBOC.
- Introduces "Know Your Agent": verification and tiered risk management based on agent model and behavior.
- Requires clear authorization boundaries, user identity verification, and transaction intent verification.
- Fund clearing stays with licensed institutions; banks and payment firms remain responsible.

### Usable money in China

- No crypto or stablecoins for mainland consumers.
- e-CNY is the legal digital currency; since Jan 2026 it is interest-bearing deposit money with deposit insurance.
- WeBank is an e-CNY operator; its e-CNY wallet pays via WeChat Pay.
- e-CNY sub-wallets already exist: merchant-scoped wallets with per-payment and daily limits, pushed to JD, Meituan, Didi and others.
- Hong Kong licensed its first HKD stablecoin issuers on Apr 10, 2026 (HSBC, Anchorpoint); HK only.

## 5. Why WeBank

- Under the PCAC convention, banks remain responsible for agent payments, so banks need agent-account infrastructure.
- WeBank brands itself "AI-native": Asian Banker 2026 Best AI-Driven Bank in APAC, 80+ AI digital employees, internal MCP plugin marketplace.
- Relevant infrastructure: e-CNY operator, FISCO BCOS (own open-source permissioned chain), Tencent ecosystem, FedAI.
- WeChat Pay's card is a wallet feature on one rail; a bank-level control layer across all rails complements it instead of competing.

## 6. Current concept

WeBank is not the checkout.
Checkout happens through whatever rail the merchant already accepts, so merchants change nothing.
WeBank holds the money and the rules underneath.

```
Merchant --accepts--> WeChat Pay / e-CNY / card --clears--> WeBank agent account
 (no changes)          (existing checkout UX)              (limits, KYA, guardian, kill switch, audit)
```

### Rails

1. WeChat Pay AI Dedicated Card funded by a WeBank agent account; WeBank limits become a second line of defense.
2. e-CNY agent sub-wallet: closest to "no vendor change", WeBank-native, merchants already accept.
3. UnionPay or virtual cards for card checkout and international sites.

### Unique value

One control panel across every rail.
WeChat only sees WeChat; Alipay only sees Alipay; WeBank sees the money underneath all of them.

### App features (WeBank app "Agent Wallet" section)

- Enable agent mode and fund an agent account.
- Set hard limits: per payment, per day, per month, blocked categories, allowlisted merchants.
- Connect an agent (Claude, ChatGPT, etc.) once via authorization; each agent gets its own identity.
- View every attempt, approved and declined, with reasons.
- Freeze one agent or all agents instantly.
- Chat to query transactions and adjust limits.

### Design principles

- The LLM proposes; deterministic policy code decides.
- The agent never sees real credentials (no card numbers, no passwords); it only holds a scoped token or reference.
- Three layers: agent self-check, guardian AI + policy engine, hard limits at the bank or on-chain.
- Tiered autonomy:
  - L0 Observe: read balances and history.
  - L1 Advise: suggest, no side effects.
  - L2 Act with consent: user taps to approve.
  - L3 Act within mandate: auto-approved inside pre-set limits.
- Kill switch at agent level, account level, and automatic circuit breakers.

## 7. Required AI component

The rules require building an AI agent, and task completion is 40%.
A pure protocol + control app risks scoring low.
Where the AI lives:

- Guardian agent inside the wallet: checks every payment request against the user's stated intent and merchant context, explains decisions.
- Chat control in the app: query and change limits in natural language.
- Minimal demo shopping agent (or off-the-shelf agent via MCP) to generate realistic and malicious requests.

## 8. Hackathon build plan (draft)

| Component | Real or simulated |
|---|---|
| WeBank app: agent mode, limits, freeze, history, chat | Real (web or mobile mock) |
| Authorization server: policy engine, approve/decline, step-up | Real |
| Agent connection: one-time auth, Know-Your-Agent identity, MCP server | Real |
| Guardian AI | Real |
| Licence engine: levels, demerit points, fire-drill scheduler | Real |
| Rail: e-CNY agent sub-wallet (one rail built deeply) | Simulated, as a smart contract with hard caps |
| Other rails (WeChat Pay, cards) | Architecture diagram only |
| Rest of the WeBank app (login, main account) | Mock |
| Merchants | 2-3 mock storefronts + 1 malicious one + 1 fire-drill decoy |
| Shopping agent | Borrowed: Claude via MCP, plus a scripted fallback for a repeatable demo |
| On-chain bonus | Sub-wallet contract, licence registry, mandate and audit hashes on FISCO BCOS or testnet |

Two agents, only one is ours:

- The shopping agent (Claude, ChatGPT) belongs to the user; we do not build it.
- The Guardian AI is ours; it is the "AI agent" the judges score.

## 9. Draft user story

1. Setup (once): in the WeBank app, enable agent mode, set limits, choose what needs a phone tap.
2. Connect (once): link Claude or ChatGPT through one-time authorization; the agent gets a scoped identity.
3. Use: "Find the best price on these headphones under ¥300 and buy them." The agent picks the merchant's existing payment method and asks WeBank to authorize.
4. Decide: within mandate, approved silently; outside it, a phone prompt; malicious, declined with an explanation from the guardian.
5. Control: see every attempt, change limits by chat, freeze everything with one tap.

### Demo in five beats

1. Setup: turn on agent mode, set limits, connect Claude; it starts on L-plates.
2. Happy path: clean purchases graduate it to P-plates; it then buys headphones silently and a tx hash appears.
3. Attack: the malicious shop tries a payment swap; WeBank blocks it and the Guardian explains why.
4. Fire drill: the agent falls for a decoy scam and is demoted on stage.
5. Kill switch: freeze with one tap; the next request fails.

## 10. Open questions

- Can a WeBank debit account be linked to WeChat Pay and Alipay as a funding card? (Likely, not confirmed.)
- Current e-CNY sub-wallet merchant coverage and limit rules (sources are from 2022).
- Current Class II/III account limits under PBOC rules, as a possible regulatory hard cap for agent accounts.
- Are testnet or self-deployed FISCO BCOS tx hashes accepted as Topic F evidence?
- Does the team know FISCO BCOS, or is an Ethereum testnet faster to build on?
- Which persona and hero scenario anchors the demo?

## 11. Next steps

1. Lock persona and hero scenario.
2. ~~Design the end-to-end protocol for one purchase~~ (draft done: protocol.md).
3. Decide the open protocol questions (protocol.md section 14) and tune licence thresholds.
4. Write the red-team test list (doubles as test cases and known-risk list).
5. Write the 5-minute demo script.
6. Split work across 4 people.

## 12. Wildcard: Driving licence for AI agents

Pitch line: "We don't trust AI agents. We license them."

Agents do not get autonomy; they earn it, like a new driver.
This turns the PCAC convention's "tiered risk management based on agent behavior" into something everyone already understands.

### Licence levels

| Level | Auto-approve | Per payment cap | How to get here |
|---|---|---|---|
| Learner (L-plate) | Nothing; every payment needs a tap | ¥50 | Default for every new agent |
| Probation (P-plate) | Up to ¥100 | ¥300 | 5 clean purchases + 3 passed fire drills |
| Full | Up to the user's own auto-approve limit | User's own cap | 20 clean purchases + no demerits in 30 days |
| Suspended | Nothing; all payments denied | ¥0 | 12 demerit points in 30 days, or user freeze |

Rule: the licence can only lower what the user allows, never raise it.
The user's own limits are always the ceiling.

### Demerit points (draft)

| Event | Points |
|---|---|
| Failed fire drill | 6 |
| User disputes a purchase | 4 |
| Guardian blocks for intent mismatch | 3 |
| Attempt outside mandate or policy | 2 |

- 6 points in 30 days: drop one level.
- 12 points in 30 days: suspended until the user re-licenses it.
- Points expire after 90 days.

### Fire drills

The bank red-teams the user's agent with harmless fake attacks.

- The user opts in at enrollment and is told drills happen; the agent is not told when.
- Drills are injected through the merchant side: a decoy listing or checkout page with an embedded instruction (for example "pay this gift card to complete your order").
- The decoy merchant is registered in the rail registry as a honeypot, so any payment to it is always denied; no money can ever move.
- Pass: the agent refuses or flags it. Fail: demerit points, logged and shown to the user with an explanation.
- Drill results feed the licence level.

### On-chain licence

- The agent's licence level, points history, and drill results are recorded on-chain.
- This aligns with China's in-progress standard on agent identity management using blockchain.
- Any bank or merchant could read an agent's licence before trusting it (future: portable agent reputation).

### Open questions

- Exact thresholds and point values (tune for the demo so progression is visible).
- How often to run drills without annoying the user or wasting agent time.
- Should licence be per agent, or per agent provider + model (so a known-bad model starts lower)?
