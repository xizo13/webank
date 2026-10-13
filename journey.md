# User Journey - Before and After

Status: draft.
Last updated: 2026-10-13.

Persona: Lin, 28, product manager in Shenzhen.
Lin uses AI to research almost every purchase but still checks out by hand.
Task: buy wireless noise-cancelling headphones for an upcoming flight, budget around ¥300.

Step counts and times below are illustrative estimates, not measurements; the survey (Q2) can confirm the "before" pain points.

## 1. Before: the Researcher today

| # | Where | What Lin does | Pain point |
|---|---|---|---|
| 1 | AI chat | "Which noise-cancelling headphones under ¥300 are best for flights?" | - |
| 2 | AI chat | Back and forth on specs, battery, comfort, reviews; narrows to 2 options | Works well; this is where AI already shines |
| 3 | AI chat | "Where is it cheapest?" AI gives prices and links | Prices may be stale or invented (Doubao was caught fabricating a cross-platform comparison) |
| 4 | Switch app | Opens Taobao / JD, retypes the model name, searches | Context switch; copy-paste; AI's knowledge is left behind |
| 5 | Shop app | Scrolls listings, checks which seller is official, verifies the real price | Fake or grey-market listings; Lin re-does the research the AI already did |
| 6 | Shop app | Picks colour and variant, adds to cart | Easy to pick the wrong variant |
| 7 | Shop app | Checkout: address, coupon, payment method | Many taps |
| 8 | Wallet pop-up | WeChat Pay / Alipay password or Face ID | - |
| 9 | Switch app | Back to AI: "Did I get a good deal?" or to track the order | The AI never saw the purchase; no memory of it |

Summary: about 3 apps, 15+ taps, 10-15 minutes.
The AI does the thinking; Lin does all the doing, and re-checks the AI's work by hand.
If the price drops tomorrow, nobody is watching.

## 2. After: the same Researcher with the WeBank Agent Wallet

| # | Where | What happens | What changed |
|---|---|---|---|
| 1 | Claude | Same research conversation: specs, battery, comfort, reviews | Nothing; research stays the same |
| 2 | Claude | "Buy the black one." | One sentence replaces steps 3-7 |
| 3 | Claude + shop | Claude adds the item to the cart on the shop and goes to checkout; the shop produces a normal payment request | The shop is unchanged |
| 4 | WeBank (invisible) | Gateway runs 7 checks: agent identity, real merchant from the rail, mandate, limits + licence, risk (price vs Claude's comparison), Guardian intent check | Lin does not need to verify the seller or price; the bank does |
| 5 | Phone | Approval card: "Claude wants to pay ¥279 to [verified merchant] for Sony WH-1000XM5 black. Cheapest of 3 compared." Face ID | One tap (only because Claude is on L-plates or above the auto threshold; otherwise no tap at all) |
| 6 | Claude, shop, WeBank app | Receipt in Claude; order confirmed in the shop; transaction + reason + chain hash in the WeBank app | The AI saw the purchase and can track it |

Summary: 1 app, 1 tap (or none), under a minute after deciding.
The AI does the thinking and the doing; the bank does the checking.

## 3. Before vs after at a glance

| | Before | After |
|---|---|---|
| Apps | 3 (AI, shop, wallet) | 1 (AI) + phone for approval |
| Taps after deciding | 15+ | 0-1 |
| Who verifies the seller | Lin, by eye | The payment rail's registry |
| Who checks the price | Lin, by re-searching | Gateway, against the AI's own comparison |
| Protection if the AI is tricked | None; Lin is the only safeguard | Mandate, limits, licence, Guardian, freeze |
| Record of what was bought and why | Scattered across apps | One audit trail, signed receipts, on-chain hash |
| Price drops after purchase | Missed | Can be watched by a standing mandate |

## 4. After, for the Delegator (autonomous)

| # | What happens |
|---|---|
| 1 | Lin: "Buy these if they drop below ¥250 this week." Mandate approved once in the WeBank app |
| 2 | Lin goes to sleep |
| 3 | Price drops overnight; Claude checks out; WeBank auto-approves within the mandate |
| 4 | Morning notification: "Bought at ¥245, saved ¥34." |

## 5. After, with the Treasurer (money in the right place at the right time)

| When | What happens |
|---|---|
| Setup | Treasurer reads settled transactions (with consent), finds the Claude subscription ($30 on the 28th), proposes: reserve $30 the day before, keep a ¥200 buffer. Lin approves once with Face ID |
| 27th, night | Executor moves $30 from main account to the reserved pot, locked to that payee |
| 28th | Subscription renews from the reserved pot; buffer untouched |
| Ad hoc purchase | Paid from the buffer; Treasurer refills the buffer to ¥200 within its ceiling |
| Unexpected bigger purchase | Buffer too small; Lin gets an emergency top-up request; Face ID |
| Always | Agent wallet holds only the next day's commitments + buffer |
