# Market Survey - AI Use in Shopping and Trust in Agent Payments

Status: ready to send.
Last updated: 2026-10-13.
Format: open-ended questions sent over text (WhatsApp, Telegram, WeChat).

## Why this survey

We cannot interview WeBank customers directly.
Instead we ask the wider population, by text, about three things:

1. How they use AI today, and how deeply.
2. Whether AI is already part of their shopping.
3. Whether they would let AI pay, and what would make them trust it.

Open answers give us real quotes for the deck; tagging them afterwards gives us the general consensus.

## Rules

- Ask about what they did, before asking what they would do.
- Never describe our product or suggest features.
- If an answer is short, follow up with "why?" or "can you give an example?"

## Message to send

> Hi! Doing a quick research for a hackathon project on AI and shopping. 5 short questions, answer as much or as little as you like. Skip anything you don't want to answer :)
>
> 1. Which AI do you use the most, and what do you usually use it for? Do you stick to one or switch between a few?
> 2. Have you ever used AI while shopping (comparing products, checking specs, finding deals)? Walk me through the last time. Did you end up buying?
> 3. Has an AI ever done something for you beyond answering questions, like booking, ordering, or connecting to your apps? What was it?
> 4. Would you let an AI pay for things on your behalf? Why or why not?
> 5. What would need to be true for you to trust it with your money?
>
> Last one: are you a student or working, and where are you based?

## Follow-ups (use only if needed)

| After | If they say | Ask |
|---|---|---|
| Q1 | A name only | "What did you last ask it?" |
| Q2 | "Yes" | "What did you ask it, and where did you buy in the end?" |
| Q2 | "No" | "How do you usually decide what to buy?" |
| Q4 | "Yes" | "Up to how much without asking you first?" |
| Q4 | "No" | "What's the main worry?" |
| Q5 | Something vague | "Can you give an example?" |

## Target

- 20-30 people in 2 days (Oct 14-16).
- Mix: students and working people; include Chinese respondents via WeChat (send in Chinese if easier).
- Known bias: our network skews young and tech-savvy; state this in the deck.

## How to analyse

Paste every reply into one table and tag each person.

| Tag | Values | Comes from |
|---|---|---|
| Segment | Searcher / Researcher / Delegator | Q1 + Q3 (one main AI with connected apps or actions = Delegator) |
| Uses AI for shopping | Yes / No | Q2 |
| AI influenced the purchase | Yes / No / n.a. | Q2 |
| Has let AI act | Yes / No | Q3 |
| Would let AI pay | Yes / With limits / No | Q4 |
| Amount without asking | Number, if given | Q4 follow-up |
| Main worry | Scam / Wrong item / Overspend / Data leak / No refund / No visibility / Other | Q4 + Q5 |
| Trust condition | Limit / Approve each / Trusted shops / Refund guarantee / Visibility / Freeze / Track record / Other | Q5 |
| Quote-worthy | Copy the exact sentence | Any |

Count each tag to find the consensus; keep the best 3-5 quotes.

## How results feed the design

| Finding | Design decision |
|---|---|
| Segment mix | Confirms Delegators as the beachhead |
| Most-used AIs | Which agents to support and demo first |
| AI used for shopping but not paying | The gap we fill (headline slide) |
| Amounts people would allow | Default auto-approve limit and licence caps |
| Top worries | Which attacks to show in the demo |
| Trust conditions | Which features to lead the pitch with; "track record" answers validate the licence idea |

## Slides this produces

- "Most people already use AI to decide what to buy, but almost no one lets it pay." (the gap)
- "People would let an agent spend up to ¥X without asking." (our defaults)
- "Top fear: ___. Here's how we stop it." (security story)
- 2-3 real quotes on one slide.
