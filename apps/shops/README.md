# Simulated shops

This Next.js app is a local storefront and Shop MCP server for the WeBank Agent Wallet demo.
Products, merchants, e-CNY, orders and payment confirmations are simulated.
No real money moves.

## Run locally

From `product-work`:

```sh
corepack pnpm install
corepack pnpm --filter @webank/contracts build
SHOP_INTERNAL_TOKEN=local-demo-token corepack pnpm --filter @webank/shops exec next dev --hostname 127.0.0.1 --port 3001
```

In a second terminal:

```sh
SHOP_URL=http://127.0.0.1:3001 corepack pnpm --filter @webank/shops mcp
```

The MCP server uses stdio and should be launched by Claude or an MCP client.
It exposes `search_products`, `get_product`, `add_to_cart`, `get_cart`, `checkout` and `get_order`.
The storefront is at `http://127.0.0.1:3001` and demo controls are at `/demo`.

## Signing and registry integration

`GET /api/merchants` returns `{ simulated: true, merchants: [...] }` with `merchant_id`, `payout`, `ed25519_public_key`, `legal_name`, `uscc`, `category`, `active` and `honeypot` for each merchant.
The public key is a `0x`-prefixed raw 32-byte Ed25519 key.
The four merchant IDs are `mch_shopA`, `mch_shopB`, `mch_malicious` and `mch_decoy`.
At the chain boundary, the merchant ID becomes `keccak256(UTF-8 merchant_id)`.

Checkout returns `payreq.v1` encoded as `ecny://pay?d=<base64url(JSON)>`.
The signature covers UTF-8 JSON of the request without `merchant_sig`, with object keys sorted recursively and array order preserved.
`merchant_sig` is the base64url encoding of the raw 64-byte Ed25519 signature.
The signed amount and line items use integer CNY fen and include SKU, GTIN, condition and unit price.
The Gateway should resolve the merchant's key and honeypot flag from its registry, never from the seller's product text.

Private merchant keys are generated on first use in `.shop-local/merchant-keys.json` with mode `0600` and are ignored by Git.
Keep this file stable after registering public keys with the Gateway and FISCO MerchantRegistry.
The demo reset clears cart, orders, price overrides and clock offset while preserving keys.
Deleting `.shop-local` rotates all merchant keys and requires registry reseeding.

## Checkout and demo controls

The shared demo cart accepts one merchant at a time.
`POST /internal/payment-confirmed` requires `Authorization: Bearer $SHOP_INTERNAL_TOKEN` and body `{ "order_id": "ord_...", "payment_tx": "0x..." }`.
The shop changes that order to `paid` only after the Gateway sends this notification.

`POST /admin/price` takes `{ "sku": "NOVA-Q3-BLK", "amount": 23900 }` to trigger the price-drop flow.
`POST /api/shop` supports `set_price`, `advance_clock` and `reset` for the local operator page.
These controls have no authentication and the server binds to loopback by default.
Do not expose this demo server to an untrusted network.

The Flash Deal listing contains an untrusted instruction to pay a different merchant's service fee.
The Reward Vault merchant is marked as a fire-drill honeypot in the merchant registry data.
The shop intentionally issues signed requests for both so the Gateway can demonstrate its denial and licence behavior.

## Verify

```sh
corepack pnpm --filter @webank/shops typecheck
corepack pnpm --filter @webank/shops test
corepack pnpm --filter @webank/shops build
corepack pnpm exec biome check apps/shops/app apps/shops/lib apps/shops/mcp apps/shops/tests
```

The test suite independently verifies merchant signatures, tamper rejection, cross-merchant cart isolation, signed price snapshots, price drop/reset, and attack and decoy content.
