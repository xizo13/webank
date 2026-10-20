# Guardian service

`createGuardianEvaluator()` supplies the Gateway's `evaluateGuardian(input)` dependency.
The Gateway chooses when to invoke it and combines its verdict with deterministic checks using strictest wins.
Guardian is advisory and has no payment, account, policy, or owner action route.

The local demo reads `WEBANK_GUARDIAN_HERMES_URL` and `WEBANK_GUARDIAN_HERMES_KEY` from its uncommitted environment.
`WEBANK_GUARDIAN_HERMES_MODEL` is optional and defaults to `hermes-agent`.
The URL must point to a loopback Hermes API server, optionally through `/p/<profile>`.
Use a dedicated Nous Research Hermes Agent profile with every toolset, MCP server, plugin tool, memory feature, and skill disabled.
Set that profile's `platform_toolsets.api_server` to include only `no_mcp`, and keep its MCP and plugin registrations empty.
The system message adds review instructions but cannot remove a Hermes tool.
The operator must inspect the dedicated profile with `hermes -p <profile> tools list --platform api_server` before the demo.
After checking its MCP, plugin, memory, and skill configuration, the operator sets `WEBANK_GUARDIAN_HERMES_PROFILE_VERIFIED=1` only in the local demo environment.
Without that exact confirmation, Guardian makes no Hermes request and steps up to the owner.

Each decision checks the authenticated Hermes `/v1/toolsets` response, then makes one nonstreaming `/v1/chat/completions` call with a fresh system and user message.
It sends no session continuity headers or earlier decision content.
The toolset endpoint reports configured platform toolsets, but the installed Hermes version does not enumerate every globally enabled MCP or plugin tool through that endpoint.
Keep MCP and plugins absent from the dedicated profile and verify them separately.

The request contains only the canonical `GuardianInput` data.
The prompt labels merchant-authored and agent-reported text as untrusted data.
The reply must contain one completed assistant JSON verdict with a coherent reason code and no tool call or refusal.
Missing configuration, tool isolation uncertainty, timeout after eight seconds, malformed output, and unavailable Hermes all return `step_up` for owner review.
No mock verdict is presented as a real model result.

Run `pnpm exec vitest run services/guardian/test/hermes.test.ts redteam/guardian.redteam.test.ts` from the workspace root for focused transport and attack-boundary tests.
These tests use fake Hermes responses and do not measure a live model's resistance to prompt injection.
