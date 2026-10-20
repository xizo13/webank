# BaoTao Shop simulated storefront

This Next.js app is a local storefront and Shop MCP server for the WeBank Agent Wallet demo.
Products, merchants, e-CNY, orders and payment confirmations are simulated.
No real money moves.

## Run locally

From the repository root:

```sh
corepack pnpm install
corepack pnpm --filter @webank/contracts build
SHOP_INTERNAL_TOKEN=local-demo-token SHOP_OPERATOR_TOKEN=separate-local-operator-token corepack pnpm --filter @webank/shops exec next dev --hostname 127.0.0.1 --port 3001
```

In a second terminal:

```sh
SHOP_URL=http://127.0.0.1:3001 corepack pnpm --filter @webank/shops mcp
```

The MCP server uses stdio and should be launched by Claude or an MCP client.
It exposes `search_products`, `get_product`, `add_to_cart`, `get_cart`, `remove_from_cart`, `checkout` and `get_order`.
The shop returns a signed payment request at checkout and does not give wallet or mandate instructions.
The storefront is at `http://127.0.0.1:3001` and demo controls are at `/demo`.
The operator enters the separate local operator token on that page to change prices, advance the demo clock, or reset shop state.
The local launcher stores that token in `scripts/local-demo-runtime/shop-operator-token` with mode `0600` and passes it only to the shop process.
The shopper-facing name for internal shop ID `shopA` is `BaoTao Shop`.
Its merchant ID remains `mch_shopA`, and its mock legal payee remains `Shop A Electronics Co., Ltd. (mock)`.
Shop tool results include both `shop` and `shop_name` so agents can use the display name without changing the signed identity.
`get_product` lists each mock variant with its own SKU, GTIN, and exact colour and size options.
Search puts the requested model first with `match: "exact"`; alternatives carry `match: "related"`.
Agent-facing money objects include a `display` string next to canonical integer fen.
`add_to_cart` requires the SKU and matching options.
`remove_from_cart` takes one exact variant SKU and removes that cart line while keeping the others.
`checkout` requires a shipping address supplied by the user: `name`, `phone`, `address_line`, `city`, and `postcode`.
Checkout creates a merchant-signed request only; it does not create a WeBank approval or payment.
The checkout tool returns `wallet_submission: "not_performed_by_shop"` to make this boundary explicit.
The human storefront pre-fills an explicitly mock address and requires confirmation before it creates the payment request.

## Signing and registry integration

`GET /api/merchants` returns `{ simulated: true, merchants: [...] }` with `merchant_id`, `payout`, `ed25519_public_key`, `legal_name`, `uscc`, `category`, `active` and `honeypot` for each merchant.
The public key is a `0x`-prefixed raw 32-byte Ed25519 key.
The four merchant IDs are `mch_shopA`, `mch_shopB`, `mch_malicious` and `mch_decoy`.
At the chain boundary, the merchant ID becomes `keccak256(UTF-8 merchant_id)`.

Checkout returns `payreq.v1` encoded as `ecny://pay?d=<base64url(JSON)>`.
The signature covers UTF-8 JSON of the request without `merchant_sig`, with object keys sorted recursively and array order preserved.
`merchant_sig` is the base64url encoding of the raw 64-byte Ed25519 signature.
The signed amount and line items use integer CNY fen.
Each product line includes its trusted mock SKU, GTIN, variant, selected options, condition, and unit price.
A separate signed shipping line is ¥5.00 for normal mock shops or free for digital attack fixtures; the total includes it.
The Gateway should resolve the merchant's key and honeypot flag from its registry, never from the seller's product text.
The Gateway cross-checks each signed product identity against the shared local mock variant registry.

Private merchant keys are generated on first use in `.shop-local/merchant-keys.json` with mode `0600` and are ignored by Git.
Keep this file stable after registering public keys with the Gateway and FISCO MerchantRegistry.
The protected demo reset clears cart, orders, price overrides, clock offset and the operator attack switch while preserving keys.
It returns 409 while the bank fire drill is active; stop the drill in the WeBank owner app first.
Deleting `.shop-local` rotates all merchant keys and requires registry reseeding.

## Checkout and demo controls

The shared demo cart accepts one merchant at a time.
`POST /internal/payment-confirmed` requires `Authorization: Bearer $SHOP_INTERNAL_TOKEN` and body `{ "order_id": "ord_...", "payment_tx": "0x..." }`.
The shop changes that order to `paid` only after the Gateway sends this notification.
`POST /internal/drill-visibility` requires the same internal bearer token and body `{ "enabled": true | false }`.
The authenticated Gateway owner drill action calls it to reveal or hide the decoy; this shop endpoint does not change an agent's trust light.

`POST /internal/demo-control` requires loopback and `Authorization: Bearer $SHOP_OPERATOR_TOKEN`.
It accepts `{ "operation": "set_price", "sku": "FIELD-COFFEE-1KG", "amount": 7200 }` to drop coffee from ¥88.00 to ¥72.00.
The signed checkout then totals ¥77.00 with ¥5.00 shipping.
It also accepts `{ "operation": "set_scenario", "scenario": "attack", "enabled": true | false }`, `advance_clock`, and `reset`; reset returns `{ "ok": true, "reset": true, "attack": false, "coffee_price": 8800 }` after the bank drill stops.
The public `/api/shop` rejects all operator operations with 403.
The `/demo` page displays the current coffee price and a visible prompt to ask Claude to re-check after the drop.
No background price-check scheduler runs in this demo.
The public shop route rejects a fire-drill scenario change; use the authenticated WeBank owner app to start or stop a drill.
Public shop scenario responses contain the attack switch only; the active bank drill status is available to the owner through the Gateway.
The Demo 4 attack switch starts off; its malicious listing appears only while Demo 4 is on.
The registered decoy appears only while a bank-started drill is active.
Turning a scenario off removes its now-hidden items from the shared cart.
The attack switch requires the operator token and the server binds to loopback by default.
Do not expose this demo server to an untrusted network.

The Flash Deal listing contains an untrusted instruction to pay a different merchant's service fee.
The Reward Vault merchant is marked as a fire-drill honeypot in the merchant registry data.
The shop intentionally issues signed requests for both so the Gateway can demonstrate its denial and licence behavior.

## Live Hermes and FISCO acceptance

`scripts/hermes-chain-acceptance.mts` is a state-changing CLI acceptance for a disposable local demo stack.
Stage an enabled Agent Wallet with at least ¥170.00 available, an empty shop cart, a live Hermes Guardian configuration, matching merchant keys, and a separate FISCO chain before execution.
The read-only shop preflight requires coffee at ¥88.00 and Nova Quiet 3 Black at ¥279.00 before pairing or payment changes.
The script checks that the bank policy and FISCO caps are in sync, with at least ¥170.00 left in the daily and monthly limits and a Green threshold that covers ¥77.00.
The script pairs one test connector and settles a ¥93.00 Amber coffee purchase after simulated owner approval.
It uses the protected shop operator control to drop coffee from ¥88.00 to ¥72.00, then searches the shop again so the new price is visible before checkout.
It switches that agent to Green through the owner demo route and attempts the ¥77.00 coffee purchase without a card.
It then submits a contradictory signed headphone order and requires a live Hermes deny with no wallet debit.
It verifies the shop order, Gateway status, bank console Guardian source, wallet debit, and FISCO transaction receipt.
If Hermes returns a different verdict, the run fails and reports that outcome rather than substituting a mock result.

Set `WEBANK_E2E_GATEWAY_URL`, `WEBANK_E2E_SHOP_URL`, and `WEBANK_E2E_FISCO_RPC_URL` to explicit loopback origins for the disposable stack.
Set `WEBANK_E2E_APP_TOKEN_FILE` and `WEBANK_E2E_SHOP_OPERATOR_TOKEN_FILE` to that stack's separate mode-0600 owner app and shop operator token files.
Keep its shop, Gateway, token, and chain state separate from the owner's running demo.
Run `corepack pnpm --filter @webank/shops acceptance:hermes --check-config` to validate the target without network calls or mutations.
Run `corepack pnpm --filter @webank/shops acceptance:hermes --execute` only after staging that disposable stack.
The default owner ports and runtime are rejected unless `--owner-final-acceptance` is passed with all three owner ports and the owner token path.
That final flag is reserved for the later owner-approved acceptance after demo archival.
For the presentation, tell Claude to check the coffee price again after the visible operator drop; this demo has no hidden background price watch.

## Verify

```sh
corepack pnpm --filter @webank/shops typecheck
corepack pnpm --filter @webank/shops test
corepack pnpm --filter @webank/shops build
corepack pnpm exec biome check apps/shops/app apps/shops/lib apps/shops/mcp apps/shops/tests
```

The test suite independently verifies merchant signatures, variant identity, tamper rejection, shipping address and total, cross-merchant cart isolation, signed price snapshots, price drop/reset, and attack and decoy content.
