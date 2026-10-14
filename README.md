# Agent Wallet MVP

This independent WeBank Fintechathon 2026 prototype explores a separate wallet for AI agents, user-approved mandates, spending limits, and visible payment decisions.
It is not a WeBank product or a live banking service.
All merchants and currency in this repository are simulated, and no real funds move.

## Implemented slices

| Area | Current behavior |
| --- | --- |
| Expo app | In-memory Agent Wallet walkthrough by default; explicit loopback mode can read Gateway state and submit a visibly simulated local approval. |
| Shops | Local Next.js storefront and Shop MCP tools with mock products, carts, orders, and Ed25519-signed payment requests. |
| Connector | Five stdio MCP tools with device-code pairing, local P-256 key, scoped tokens, and signed agent requests; tested against a contract-shaped HTTP stub. |
| Gateway | Fastify payment and pairing logic with scoped agent authentication, replay protection, policy and mandate checks, optional Guardian verdict, receipts, audit records, and an opt-in loopback FISCO composition. |
| Chain | Five Solidity demo contracts and a viem adapter tested against a local non-SM FISCO BCOS v3.17.1 chain. |
| Treasurer | Separate in-memory proposal, funding, and monitor simulation; it is not connected to live bank accounts or chain settlement. |

The CLI integration driver has exercised shop checkout, the actual connector client, Gateway checks, simulated app approval and reservation, local FISCO settlement, shop confirmation, and app payment detail in one path.
This is not a live Claude session or a bank-verifiable phone approval.
The separate limited Gateway fixture supports read, reject, and freeze demonstrations but cannot approve a card or move money.

## Requirements and checks

Use Node.js 22 and Corepack with the pinned pnpm 10.18.0 workspace.
Run from this repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
```

`check` runs Biome, builds workspace packages in dependency order, then runs TypeScript checks and the default Vitest suite.
The local FISCO integration test is opt-in and is skipped by the default test command.
See [verification and known limits](docs/verification.md) for the latest recorded checks and acceptance gaps.

## Local demonstrations

For the integrated loopback demonstration on macOS arm64, use the [local demo operator guide](scripts/local-demo-README.md).
With the pinned dependencies and local FISCO runtime already present, `./scripts/local-demo-up.sh` starts the static Expo web export, mock shop, strict local Gateway, and four-node chain on loopback.
`./scripts/local-demo-down.sh` stops only the processes recorded by the operator.
The launcher does not install dependencies or open a browser.
The web approval is explicitly simulated, while the contract deployment and test-token payment use real transactions on the local permissioned chain.

The individual components can also be explored separately.
Start the Expo web preview for the in-memory app walkthrough:

```sh
corepack pnpm --filter @webank/webank-app web
```

Start the mock storefront on loopback:

```sh
SHOP_INTERNAL_TOKEN=local-demo-token corepack pnpm --filter @webank/shops exec next dev --hostname 127.0.0.1 --port 3001
```

The storefront is at `http://127.0.0.1:3001`, with local demo controls at `/demo`.
The app's default simulation does not call this storefront or the chain.
See the [app](apps/webank-app/README.md), [shop](apps/shops/README.md), [Gateway](services/gateway/README.md), and [connector](agents/connector-mcp/README.md) READMEs for each separate mode.

On macOS arm64, `./scripts/chain-up.sh` starts a local four-node non-SM FISCO chain, downloads pinned official tooling on first use, and deploys the demo contracts.
`./scripts/chain-down.sh` stops the chain processes started by that operator.
The chain is optional for the default app and shop demonstrations; see the [chain operator guide](scripts/chain/README.md) before running it.

## Architecture and security boundary

The [architecture](docs/architecture.md) names each implemented interface and the adapters still supplied by test fixtures.
The connector stores a software private key in a local file, so an AI with the same user's filesystem access can read it.
The app has no production Secure Enclave action signer, and a successful local Face ID prompt is not a bank-verifiable payment approval.
Gateway state is in memory, and the local FISCO token is not e-CNY.
Do not use this prototype for real credentials, customer data, or payments.
