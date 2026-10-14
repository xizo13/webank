# Guardian service

`createGuardianEvaluator()` supplies the Gateway's `evaluateGuardian(input)` dependency.
The Gateway chooses when to invoke it and combines its verdict with deterministic checks using strictest wins.
Guardian is advisory and has no payment, account, or policy access.

Set `ANTHROPIC_API_KEY` to enable a live Claude call.
The default model is `claude-opus-5-5` with an eight-second deadline.
The Claude request enables server-side refusal fallback using Anthropic's `2026-07-01` beta.
An absent key, timeout, refusal, malformed response, or oversized input returns `step_up` for human review.
No mock verdict is returned as a real model result.

The request is limited to the canonical `GuardianInput` contract.
The model prompt labels merchant-authored and agent-reported text as untrusted data.
The SDK uses structured output, and the result is validated again against the shared verdict contract.

Run `npm exec --yes --package=pnpm@10.18.0 -- pnpm test redteam/guardian.redteam.test.ts` from the workspace root for deterministic attack-boundary tests.
Those tests use a fake model response to probe whether Gateway checks still deny a mismatched GTIN, swapped payee, and decoy merchant.
They do not measure a live model's resistance to prompt injection; that requires an API key and a separate red-team run.
