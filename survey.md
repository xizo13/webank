# Market Survey - AI Use in Shopping and Trust in Agent Payments

Status: draft.
Last updated: 2026-10-13.

## Why this survey

We cannot interview WeBank customers directly.
Instead we measure the wider population on three things:

1. How heavily people already use AI, and in what mode.
2. How much AI is already part of their shopping (research, comparison, specs, deals).
3. How much they would trust an AI to pay, and what would make them comfortable.

## Hypothesis: three user segments

| Segment | How they use AI | Friction to adopt the Agent Wallet |
|---|---|---|
| Searchers | Ad-hoc chatbot for quick questions and search (e.g. Gemini, Doubao in a browser) | High: no persistent agent to plug a wallet into |
| Researchers | Use AI to compare products, brands, specs, reviews; still check out themselves | Medium: already trust AI for decisions, not yet for payment |
| Delegators | One main personal assistant with memory and connected apps (e.g. Claude, ChatGPT with connectors) | Low: plugging in a wallet is one more connection |

Beachhead: Delegators.
Growth path: Researchers become Delegators as assistants get more capable.
The survey tells us how big each segment is and what blocks each one.

## Target

- 50-100 responses in 2 days.
- Channels: university groups, friends, WeChat groups (include Chinese respondents, since the product targets the Chinese market).
- Known bias: students skew young and tech-savvy; state this in the deck.
- Length: under 3 minutes, all multiple choice except one optional free-text question.

## Questions

### Section A - AI use

1. How often do you use an AI assistant?
   - Never / A few times a month / Weekly / Daily / Many times a day
2. Which AI do you use most? (pick one)
   - ChatGPT / Claude / Gemini / DeepSeek / Doubao / Qwen / Yuanbao / Kimi / Other
3. What do you mostly use it for? (pick up to 3)
   - Quick questions or search
   - Writing or editing
   - Study or work research
   - Comparing products or making buying decisions
   - Personal assistant tasks (email, calendar, reminders)
   - Letting it take actions for me (booking, ordering, filling forms)
4. Do you mostly use one main AI, or switch between several?
   - One main AI that knows my preferences / 2-3 depending on task / Whatever is handy at the time
5. Have you connected your AI to any of your apps or accounts? (pick all)
   - Email / Calendar / Notes or files / Shopping or delivery apps / Payment apps / None

### Section B - AI in shopping

6. In the last month, did you use AI for any part of shopping? (pick all)
   - Comparing two products or brands
   - Checking specifications
   - Summarising reviews
   - Finding deals or the lowest price
   - Deciding what to buy
   - Building a cart or placing an order
   - Paying
   - None
7. The last time AI helped you shop, what happened next?
   - I bought what it suggested / I bought something else / I didn't buy / I haven't used AI for shopping

### Section C - Trust in AI payments

8. What is the most you would let an AI spend for you without asking you first?
   - Nothing, I want to approve every payment / Under ¥50 / ¥50-300 / ¥300-1,000 / Over ¥1,000
9. What worries you most about letting AI pay? (pick up to 2)
   - It gets tricked by a scam or fake website
   - It buys the wrong thing
   - It spends more than I wanted
   - My payment details get leaked
   - I can't undo or get a refund
   - I don't know what it did or why
   - Nothing, I'd be fine with it
10. Which would make you most comfortable letting AI pay? (pick up to 3)
    - A hard spending limit I set
    - Approving each payment on my phone
    - Only paying merchants I trust
    - My bank guarantees a refund if the AI makes a mistake
    - Seeing every payment and why it was made
    - Being able to freeze it instantly
    - The AI earns more freedom only after proving it's reliable
11. (Optional) Describe a time AI helped or failed you while shopping.

### Section D - About you

12. Age: Under 18 / 18-24 / 25-34 / 35-44 / 45+
13. Where do you live? China mainland / Hong Kong, Macao, Taiwan / Singapore / Other Asia / Europe / Americas / Other
14. Student / Working / Other

## How each answer feeds the design

| Question | Design decision it informs |
|---|---|
| 1-5 | Segment sizes; whether Delegators are a real beachhead |
| 2 | Which agents to support first (Claude, ChatGPT vs. Doubao, Qwen) |
| 6-7 | Evidence that AI already drives buying decisions; checkout is the missing step |
| 8 | Default auto-approve threshold and licence level caps |
| 9 | Which threats to demo; ordering of the 7 checks in the pitch |
| 10 | Which features to lead with; validates the licence wildcard (last option) |
| 11 | Real quotes for the deck |

## Slides this produces

- "X% of people already use AI to decide what to buy; Y% let it pay." (the gap we fill)
- "Most would let an agent spend up to ¥Z without asking." (our default limits)
- "Top fear: ___. Here's how we stop it." (security story)
- "N% want AI to earn freedom by proving itself." (the licence idea, validated)
