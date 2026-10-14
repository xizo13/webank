# Gateway integration slice

`createGateway(dependencies, seed)` builds the Fastify service.
The composition layer supplies an authenticated app session, reservation ledger, risk and Guardian services, receipt signing key, and chain connection.
The package does not start a listener by itself.

## HTTP behavior

- `/v1/oauth/device_authorization` starts a ten-minute device pairing and returns a six-digit request number only to the connector.
- `/v1/app/pairing/:userCode` shows the pairing card without the request number, and `/approve` is disabled outside explicit demo tests until a secure device key verifier exists.
- `/v1/oauth/token` polls or rotates one-time refresh tokens; access tokens expire after 900 seconds.
- `/v1/agent/*` requires an access token and the connector's RFC 9421 P-256 signature over method, path, content digest, and idempotency key.
- Agent mandate, payment, status, and own-history routes enforce scope, signature time, nonce replay, mandate constraints, merchant signature, policy, licence, risk, Guardian, and approval rules.
- App routes expose pairing consent, filtered approvals, agents and freeze, payment history and receipt detail, audit history, and `/v1/app/events?after=<cursor>` polling.

The six named `Decision.checks` represent protocol checks 1 through 6.
The seventh protocol check is the strictest-result merge into `Decision.outcome`.
The contract wallet applies a final cap and balance check when the FISCO adapter executes payment.
L-plate agents need app approval for mandates and every payment.
Their first payment requires a six-digit number, and three mismatches cancel the approval.
No agent-provided description is treated as confirmed user intent.

## FISCO adapter

`createFiscoGatewayAdapters` reads merchant identity and its raw Ed25519 key from the on-chain MerchantRegistry.
It requires bank-controlled off-chain classification for merchant display name, first-seen status, and honeypot flag; a missing classification fails closed.
Payment and audit methods wait for successful transactions and verify matching `Paid` and `Anchored` events before returning hashes.
The adapter is injected into `createGateway`; it does not implement reservation, app verification, risk, Guardian, or notification delivery.

## Opt-in mock app listener

From `product-work`, run `WEBANK_DEMO_SERVER=1 WEBANK_DEMO_APP_ORIGIN=http://127.0.0.1:8081 pnpm --filter @webank/gateway demo` to start a loopback-only fixture at port 3002.
The process prints an ephemeral login token and pairing code.
`POST /demo/login` with `Authorization: Bearer <printed-token>` sets an HttpOnly demo session cookie for credentialed browser requests.
The listener seeds one mock agent, one pending payment approval, and one pairing request so the app can exercise reads, rejection, freeze, and denied-receipt refresh.
Its merchant, funds reservation, risk, audit anchor, and receipt key are simulated; the Guardian adapter is the real fail-closed module with no API key.
The listener cannot approve a card or move money and refuses to start in `NODE_ENV=production`.
The browser origin must match `WEBANK_DEMO_APP_ORIGIN` exactly.

## Loopback FISCO demonstration listener

`local-demo` is a separate opt-in composition for the interactive local prototype.
It requires `WEBANK_LOCAL_DEMO=1` and `WEBANK_DEMO_APPROVALS=1`, refuses production mode, and binds only to `127.0.0.1`.
Start the local FISCO chain and the shop on `127.0.0.1:3001` with the same persistent merchant keys that were registered on-chain.
The shop and Gateway must share a nonempty `SHOP_INTERNAL_TOKEN`.
Load the ignored local Gateway signer environment, then start from `product-work`:

```sh
set -a
. scripts/chain/runtime/gateway.env
set +a
WEBANK_LOCAL_DEMO=1 WEBANK_DEMO_APPROVALS=1 SHOP_INTERNAL_TOKEN=local-demo-token corepack pnpm --filter @webank/gateway local-demo
```

The listener verifies the shop's merchant identities against the bank-controlled manifest and the FISCO registry before accepting requests.
It prints an ephemeral app login token for `POST /demo/login`; the response sets a local HttpOnly session cookie and explicitly says `simulated: true`.
The connector uses the normal OAuth device flow and RFC 9421 P-256 signatures, and Gateway checks the shop's Ed25519-signed payment request.
Local app approval uses the literal `simulated-local-approval` proof, records the mandate source as `demo_simulation`, and is not a biometric or bank-verifiable approval.
The funds reservation and risk signal are local simulations; the Guardian runs in its fail-closed unavailable mode.
After FISCO returns a matching `Paid` event and the receipt audit is anchored, Gateway calls the shop's authenticated `/internal/payment-confirmed` endpoint.
If confirmation fails, Gateway returns `503 reconciliation_required` with the verified payment transaction hash, keeps the mandate locked, and does not retry the payment through the approval endpoint.
The shop and chain use only simulated merchants and test tokens.

## Verification

From `product-work`, run `pnpm --filter @webank/gateway typecheck`, `pnpm --filter @webank/gateway test`, and `biome check services/gateway` with the pinned workspace tools.
The default tests use HTTP requests against the Fastify service and controlled external adapters.
The signature tests import the connector's actual `signAgentRequest` helper.
`WEBANK_LIVE_GATEWAY=1` enables `test/live-fisco.test.ts`, which requires the fixed local FISCO deployment, seeded merchant registry, a running shop at `WEBANK_SHOP_URL` or port 3001, and `FISCO_GATEWAY_PRIVATE_KEY` in the test process environment.
The live test explicitly enables a test-only proof callback and uses fixture app session, reservations, risk, and Guardian adapters while checking real chain transaction events.

On 2026-10-14 at 13:07 China Standard Time, the opt-in live test passed against the final fixed local wallet `0x1710Ae6D428159c7C96b3576855b74d77359baC7` and registry `0x902d28E041d203a26b97E8F298CC896Eb8808Fcd`.
The test observed matching `Paid` and `Anchored` events, verified the signed receipt, recorded a tampered-payment denial, and confirmed that freeze blocked the agent's next request.

## Limits

Gateway state, tokens, nonces, idempotency keys, mandates, approvals, and audits are in memory.
This slice must not be deployed across restarts or replicas.
No production biometric challenge verifier, persistent reservation hold, risk service, SSE delivery, or recovery worker is wired here yet.
Merchant fulfillment confirmation is wired only in the opt-in loopback composition.
The Guardian module is integrated as an injectable dependency and fails closed to step-up when unavailable; no live AI call has been demonstrated here.
Demo proof approval requires `demoApprovalsEnabled: true` plus either a test process or `WEBANK_DEMO_APPROVALS=1`, and the Gateway refuses demo proof mode in production.
The app event endpoint is JSON polling, while the canonical contract currently specifies SSE.
The app freeze endpoint blocks future Gateway requests immediately, while on-chain freeze is a separate bank-controlled operation.
An uncertain rail or audit failure locks the payment for reconciliation and returns 503 without claiming completion.
