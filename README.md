# WeBank Agent Wallet

"We don't trust AI agents. We license them."

WeBank Fintechathon 2026, International Track, Topic F (Agent Wallet).
Deadline: Oct 20, 2026, 23:59 Beijing time.

## Files

| File | What's in it |
|---|---|
| README.md | This one-pager: the idea, why it wins, what we build |
| brainstorm.md | Hackathon facts, decision trail, market research, concept, licence rules, open questions |
| protocol.md | End-to-end protocol for one purchase, data schemas, threat table, on-chain design |
| survey.md | Market survey: AI use, AI in shopping, trust in agent payments; user segments |
| demo.md | Supported agents (Claude first, Doubao stretch), five demo flows, mock shop requirements |
| standards.md | Review of AP2, ACP, Visa/Mastercard, MCP auth, OWASP, APOP, PCAC; every adopted feature with its purpose |

## Target user

Beachhead: "Delegators", people who rely on one main AI personal assistant with memory and connected apps.
For them, plugging in a wallet is one more connection.
Casual chatbot users ("Searchers") face high friction and come later.
Onboarding is "as easy as `gh auth login`": set up once in the WeBank app, authorize each agent once with a code or a "Connect WeBank" button.
Making that one step painless is how we also capture "Researchers" who already bank with WeBank.
Segment sizes to be validated by the survey.

Hero persona: Lin, 28, product manager in Shenzhen, a Delegator.
Lin already lets an AI assistant handle email and calendar and uses it to research every purchase, but still checks out by hand because they do not trust it with money.
Pitch ending: "Next month, Lin sets up the same wallet for their parents."

## The problem

AI agents are starting to shop and pay for people, but giving an agent money is all-or-nothing.
Hand over full access, or approve every step and lose the point of an agent.
Agents can be tricked by malicious pages, make mistakes, and leave no clear record of who authorized what.

## The idea

A separate pot of money inside the user's WeBank account that AI agents can spend from.
The rules are enforced by the bank, not by the AI.

1. Set up once: turn on agent mode in the WeBank app, fund it, set limits.
2. Connect once: Claude, ChatGPT or any agent pairs with a code and gets its own verified identity (Know Your Agent); it never sees the user's credentials.
3. Give a task: "Buy headphones under ¥300" becomes a mandate, a scoped temporary permission with a reserved budget.
4. The agent shops anywhere; at checkout it hands the merchant's ordinary payment request to WeBank; merchants change nothing.
5. WeBank decides through 7 checks, including the Guardian AI matching the purchase against what the user asked for: approve, ask the user, or block.
6. Every attempt, including blocked ones, shows in the app with a reason and is anchored on-chain.
7. The user changes limits by chat and can freeze one or all agents with one tap.

## The wildcard: a driving licence for agents

- New agents start on L-plates: small limits, every payment needs a tap.
- Clean purchases earn autonomy: L-plate to P-plate to full licence.
- Mistakes cost demerit points, leading to demotion or suspension.
- Fire drills: the bank slips the agent a harmless fake scam; agents that fall for it lose points; the decoy merchant is always blocked, so no money moves.
- The licence lives on-chain, in line with China's in-progress standard on blockchain-based agent identity.
- The licence can only tighten the user's limits, never loosen them.

## Why it wins

| Criterion | How we score |
|---|---|
| Task completion (40%) | Real end-to-end purchases through real checks, with real on-chain tx hashes |
| Security & compliance (30%) | Three layers (agent, guardian + policy, on-chain hard caps); guardian can only make decisions stricter; built to China's Aug 2026 agent-payment convention (Know Your Agent) |
| Innovation (30%) | Agent licensing and fire drills; nobody else does this |
| On-chain bonus | Sub-wallet smart contract with hard caps, plus on-chain licence registry |

## Where we sit in the market

- UnionPay (APOP) and Ant (AMP) build plumbing between merchants and payment networks.
- Alipay and WeChat Pay each control agents on their own rail only.
- We are the user's single control point at the bank, across every rail, and the first to make agents earn trust.

## What we build

| Real | Mock | Borrowed |
|---|---|---|
| Agent Gateway (identity, mandates, 7 checks, licence engine) | Rest of the WeBank app | Shopping agent (Claude via MCP) |
| Guardian AI (our AI agent) | 2-3 shops + 1 malicious shop + 1 fire-drill decoy | |
| Wallet connector for agents (MCP tools) | e-CNY rail (as a smart contract token) | |
| Smart contracts (sub-wallet, licence registry, audit anchors) | | |
| Agent Wallet screens in the app (setup, limits, approvals, history, chat, freeze) | | |

## Demo in five flows (details in demo.md)

1. Setup: WeBank app, create a separate agent wallet, set limits, scan QR in Claude, Face ID; starts on L-plates.
2. Research then "buy it for me": back-and-forth on specs and sizing; L-plate means a Face ID tap; receipts in Claude, shop and app.
3. Autonomous: "buy when it drops below ¥250"; auto-approved within the mandate.
4. Attack: malicious listing tricks Claude; WeBank blocks it and the Guardian explains.
5. Fire drill + kill switch: agent demoted live, then one-tap freeze.

Primary agent: Claude. Stretch: Doubao via its Open API and our wrapper.

## Decided

- Topic F; bonus open to all topics; no chain restriction.
- Separate agent wallet (not limits on the main account).
- QR-code authorization (redirect on mobile).
- Standing mandates via recurrence + budget (AP2 style).
- Approval screens contain no AI; chat only proposes.

## Still to decide

- Auto-approve threshold for small mandates.
- What the Guardian sees (user's original words or only the mandate).
- Licence thresholds and fire-drill frequency.
- FISCO BCOS vs. Ethereum testnet.
- Live demo, recorded video, or both.
- Work split across 4 people.
