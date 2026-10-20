# Gateway integration slice

`createGateway(dependencies, seed)` builds the Fastify service.
The composition layer supplies an authenticated app session, reservation ledger, risk and Guardian services, receipt signing key, and chain connection.
The package does not start a listener by itself.

## HTTP behavior

- `/v1/oauth/device_authorization` starts a ten-minute device pairing and returns a six-digit request number only to the connector.
- `/v1/app/pairing/:userCode` shows the pairing card without the request number, and `/approve` is disabled outside explicit demo tests until a secure device key verifier exists.
- `/v1/oauth/token` polls or rotates one-time refresh tokens; access tokens expire after 900 seconds.
- `/v1/agent/session` reads current Gateway trust state with a fresh P-256 key proof, even when spending tokens have expired or been revoked.
- `/v1/agent/session/revoke` revokes that key and its token grants; re-pairing creates a separate independent identity after owner approval.
- `/v1/oauth/device_authorization/:deviceCode` and `/v1/agent/approvals/:id` long-poll for pairing or approval changes.
- `/v1/app/pairings` lists only pairings claimed by the authenticated owner, including pending countdowns and expired attempts without device codes or request numbers.
- Every pairing creates a fresh Amber agent for the named client app, even when same-provider prior records exist; old records and audit history stay intact.
- The owner can prepare and simulate Unfreeze, idle Re-approval, and Return to Amber with single-use action challenges in the loopback demo; production routes fail closed until the biometric Secure Enclave verifier is installed.
- The owner can Delete agent access with an exact named-agent confirmation; payment and audit history remain.
- `/v1/agent/*` requires an access token and the connector's RFC 9421 P-256 signature over method, path, content digest, and idempotency key.
- Agent mandate, payment, status, and own-history routes enforce scope, signature time, nonce replay, mandate constraints, merchant signature, policy, licence, risk, Guardian, and approval rules.
- `POST /v1/agent/mandates` proposes a bounded mandate from the user's request before shopping and returns a pending or active mandate.
- App routes expose pairing consent, filtered approvals, agents and freeze, payment history and receipt detail, audit history, and `/v1/app/events?after=<cursor>` polling.
- In the opt-in local demo, `/demo/console` displays an allowlisted, read-only timeline of pairing, mandate, payment checks, Guardian verdict, approval, and verified settlement evidence.
- The Console and its JSON event feed accept only loopback peers and hosts, reject mismatched browser origins, and omit tokens, keys, raw prompts, and personal data.

The six named `Decision.checks` represent protocol checks 1 through 6.
The seventh protocol check is the strictest-result merge into `Decision.outcome`.
The contract wallet applies a final cap and balance check when the FISCO adapter executes payment.
An attended one-time mandate stays `pending_checkout` without spending authority or an approval card until a signed order is checked.
Amber agents need one composite payment approval for every attended purchase, with a six-digit request number on the first payment.
An upfront mandate for unattended work can require a separate creation approval before shopping.
Eligible Green payments under the owner's threshold can be paid without an approval card only after all checks pass; Red agents cannot spend.
Three request-number mismatches cancel the applicable zero-trust approval.
No agent-provided description is treated as confirmed user intent.
Gateway checks the signed checkout request against the mandate's locked amount, merchant, category, product, listing, variant, and execution window when those limits apply.
In the local demo, Gateway also checks each signed product SKU, GTIN, variant, and options against the trusted mock catalogue before evaluating the mandate.
Shipping is a separate signed line included in the total and caps, but excluded from product quantity and identity checks.
Checkout cannot create or broaden a mandate.

## App identity, trust, and Guardian

The connector derives a separate credential namespace from the MCP host's exact self-reported `clientInfo.name`.
The consent screen states that one app pairing covers every chat in that app; changing the app name requires a new pairing.
Seven days without a completed payment or owner authorization pauses spending until the owner Re-approves that app and the same key renews its tokens.
Status checks and token refreshes do not extend that deadline.
Trust lights are Amber, Green, and Red, with owner freeze tracked separately.
Bank-owned drill and dispute evidence can change trust; agent and public shop routes cannot promote an agent.
The local Green fast-forward is marked as a demo override and does not invent purchases or change limits.
Return to Amber requires owner review of trust evidence and a fresh owner action.
The Guardian can use a dedicated local Nous Research Hermes Agent profile for one fixed, stateless review call.
The Gateway requires local operator confirmation of tool isolation and checks the advertised API-server toolsets before each call.
Missing configuration, uncertain isolation, invalid output, or an unavailable Hermes instance causes owner step-up.
The [Guardian guide](../guardian/README.md) details the isolation requirements and transport limits.
The fixed Guardian input carries a bank-verified merchant ID bound to the signed request, so the model does not infer merchant identity from merchant-authored display text.

## FISCO adapter

`createFiscoGatewayAdapters` reads merchant identity and its raw Ed25519 key from the on-chain MerchantRegistry.
It requires bank-controlled off-chain classification for merchant display name, first-seen status, and honeypot flag; a missing classification fails closed.
Payment and audit methods wait for successful transactions and verify matching `Paid` and `Anchored` events before returning hashes.
The adapter is injected into `createGateway`; it does not implement reservation, app verification, risk, Guardian, or notification delivery.

## Opt-in mock app listener

From the repository root, run `WEBANK_DEMO_TOKEN_FILE=/absolute/private/login-token WEBANK_DEMO_SERVER=1 WEBANK_DEMO_APP_ORIGIN=http://127.0.0.1:8081 pnpm --filter @webank/gateway demo` to start a loopback-only fixture at port 3002.
Set `WEBANK_DEMO_TOKEN_FILE` to an absolute path for a new private file before starting the listener.
The process creates that file with mode `0600` before listening and prints the pairing code without printing the login token.
`POST /demo/login` with `Authorization: Bearer <token-from-private-file>` sets an HttpOnly demo session cookie for credentialed browser requests.
The listener seeds one mock agent, one pending payment approval, and one pairing request so the app can exercise reads, rejection, freeze, and denied-receipt refresh.
Its merchant, funds reservation, risk, audit anchor, and receipt key are simulated; the Guardian adapter is the real fail-closed module with no API key.
The listener cannot approve a card or move money and refuses to start in `NODE_ENV=production`.
The browser origin must match `WEBANK_DEMO_APP_ORIGIN` exactly.

## Loopback FISCO demonstration listener

`local-demo` is a separate opt-in composition for the interactive local prototype.
It requires `WEBANK_LOCAL_DEMO=1` and `WEBANK_DEMO_APPROVALS=1`, refuses production mode, and binds only to `127.0.0.1`.
Start the local FISCO chain and the shop on `127.0.0.1:3001` with the same persistent merchant keys that were registered on-chain.
The shop and Gateway must share a nonempty `SHOP_INTERNAL_TOKEN`.
Load the ignored local Gateway signer environment, then start from the repository root:

```sh
set -a
. scripts/chain/runtime/gateway.env
set +a
WEBANK_LOCAL_DEMO=1 WEBANK_DEMO_APPROVALS=1 WEBANK_LOCAL_DEMO_TOKEN_FILE=/absolute/private/login-token SHOP_INTERNAL_TOKEN=local-demo-token corepack pnpm --filter @webank/gateway local-demo
```

Set `WEBANK_LOCAL_DEMO_TOKEN_FILE` to an absolute path for a new private file before starting this standalone listener.
The normal `scripts/local-demo-up.sh` launcher sets that path to `scripts/local-demo-runtime/app-login-token` automatically.
The listener verifies the shop's merchant identities against the bank-controlled manifest and the FISCO registry before accepting requests.
It creates the local app login token file with mode `0600` before listening and never prints the token.
`POST /demo/login` with the token sets a local HttpOnly session cookie and explicitly says `simulated: true`.
Fresh funded local demo state starts with the Agent Wallet disabled, and `GET /v1/app/home` exposes that persisted status.
The funding rail and bank executor recognize completed migration manifests and native fresh funded manifests with the bank address, deployment fingerprint, and all seven deployment transaction hashes; a partial funded manifest fails startup.
The authenticated owner prepares a 60-second `wallet_enable.v1` action at `/v1/app/agent-wallet/enable/prepare` and commits it at `/v1/app/agent-wallet/enable` with the exact labeled simulated owner proof and an idempotency key.
Gateway anchors the exact action before durably enabling the wallet; an uncertain state write fences ingress until restart and durable reconciliation.
Pairing, agent mandates and payments, owner funding, and owner payment approval fail closed while the wallet is disabled.
An older durable snapshot without this field remains enabled on ordinary restart, preserving its established authority.
The connector uses the normal OAuth device flow and RFC 9421 P-256 signatures, and Gateway checks the shop's Ed25519-signed payment request.
Local app approval uses the literal `simulated-local-approval` proof, records the mandate source as `demo_simulation`, and is not a biometric or bank-verifiable approval.
The funds reservation and risk signal are local simulations; Guardian uses fail-closed owner step-up unless an operator has configured and verified the dedicated local Hermes profile.
After FISCO returns a matching `Paid` event and the receipt audit is anchored, Gateway calls the shop's authenticated `/internal/payment-confirmed` endpoint.
If confirmation fails, Gateway returns `503 reconciliation_required` with the verified payment transaction hash, keeps the mandate locked, and does not retry the payment through the approval endpoint.
The shop and chain use only simulated merchants and test tokens.

The loopback Gateway persists its app session, receipt signer, agent grants, replay nonces, approvals, payment intents, and receipts in the ignored `scripts/local-demo-runtime` directory.
Its state files are mode `0600` inside a mode `0700` directory, and the Gateway refuses corrupt, mismatched-deployment, or concurrently opened state.
After an unclean Gateway stop, a stale writer lock requires manual recovery.
First confirm that the recorded Gateway PID is no longer running; then remove only the lock file and start the demo again:

```sh
./scripts/local-demo-down.sh
state_lock=scripts/local-demo-runtime/gateway-state.json.lock
lock_pid=$(cat "$state_lock")
if ps -p "$lock_pid" >/dev/null; then
  echo "The recorded writer is still running; inspect it before removing the lock."
  exit 1
fi
rm -- "$state_lock"
./scripts/local-demo-up.sh
```

If `WEBANK_GATEWAY_STATE_PATH` overrides the default, use that absolute path with `.lock` appended.
Never delete the state or identity files to recover from an uncertain payment.
Historical Gateway snapshots may contain a replacement spending fence from the retired replacement flow.
Keep those records and seek operator review if startup reports an unresolved historical fence.
Pending historical pairings lose their old replacement choice on restart and need a fresh app consent hash before approval.
An audit anchor failure leaves pairing pending with no new agent grant; retry with a fresh idempotency key after chain recovery.
Before accepting requests after startup, Gateway releases and durably cancels active mandates left on revoked or deleted agents; it does not release a mandate with an in-flight payment.
If an orphan hold cannot be released, startup fails and preserves the mandate for operator recovery.
If a state write fails after the snapshot may have been replaced, Gateway rejects new requests at ingress with `503 service_unavailable` and changes in-flight responses to the same error.
An already admitted request may have started external work; restart reconciles state from disk before Gateway accepts requests again.

## Verification

From the repository root, run `pnpm --filter @webank/gateway typecheck`, `pnpm --filter @webank/gateway test`, and `biome check services/gateway` with the pinned workspace tools.
The default tests use HTTP requests against the Fastify service and controlled external adapters.
The signature tests import the connector's actual `signAgentRequest` helper.
`WEBANK_LIVE_GATEWAY=1` enables `test/live-fisco.test.ts`, which requires the fixed local FISCO deployment, seeded merchant registry, a running shop at `WEBANK_SHOP_URL` or port 3001, and `FISCO_GATEWAY_PRIVATE_KEY` in the test process environment.
The live test explicitly enables a test-only proof callback and uses fixture app session, reservations, risk, and Guardian adapters while checking real chain transaction events.

On 2026-10-14 at 13:07 China Standard Time, the opt-in live test passed against the final fixed local wallet `0x1710Ae6D428159c7C96b3576855b74d77359baC7` and registry `0x902d28E041d203a26b97E8F298CC896Eb8808Fcd`.
The test observed matching `Paid` and `Anchored` events, verified the signed receipt, recorded a tampered-payment denial, and confirmed that freeze blocked the agent's next request.

## Limits

The opt-in loopback Gateway persists its local state across a single-process restart and does not support replicas.
The separate limited `demo` fixture keeps state in memory.
No production biometric challenge verifier, persistent reservation hold, risk service, SSE delivery, or recovery worker is wired here yet.
The local action verifier accepts only the explicit demo proof and is not a phone biometric or a bank-verifiable device signature.
Merchant fulfillment confirmation is wired only in the opt-in loopback composition.
The Guardian module is integrated as an injectable dependency and fails closed to step-up when unavailable.
The dedicated isolated Hermes profile passed three synthetic live decisions and a full signed local shop-to-app acceptance run with an Amber owner card, a Green ¥77.00 auto-payment on FISCO without a card, and a contradictory signed order denied by Hermes without a wallet debit.
This uses simulated currency, merchants, and browser approval proof.
Demo proof approval requires `demoApprovalsEnabled: true` plus either a test process or `WEBANK_DEMO_APPROVALS=1`, and the Gateway refuses demo proof mode in production.
The app event endpoint uses JSON polling.
The app freeze endpoint blocks future Gateway requests immediately, while on-chain freeze is a separate bank-controlled operation.
An uncertain rail or audit failure locks the payment for reconciliation and returns 503 without claiming completion.
