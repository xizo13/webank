# We-AIlowance Agent Wallet prototype

This independent WeBank Fintechathon 2026 prototype explores a separate wallet for AI agents, user-approved mandates, spending limits, and visible payment decisions.
It is not a WeBank product or a live banking service.
All merchants and currency in this repository are simulated, and no real funds move.

## Implemented slices

| Area | Current behavior |
| --- | --- |
| Expo app | Browser walkthrough by default; explicit loopback web mode reads simulated balances and Gateway state and submits visibly simulated local approvals; an iOS development build has not been verified. |
| Shops | Local Next.js storefront and Shop MCP tools with mock products, carts, orders, Ed25519-signed payment requests, and separate authenticated operator controls. |
| Connector | Nine stdio MCP tools with a separate self-reported client-app identity, device-code pairing, user-intent mandate proposal before shopping, local P-256 key, scoped tokens, and signed agent requests. |
| Gateway | Fastify payment and pairing logic with scoped agent authentication, replay protection, owner wallet enablement, attended purchase approval, Amber/Green/Red trust rules, optional fixed-call Guardian review, a read-only local Bank Console, receipts, audit records, and an opt-in loopback FISCO composition. |
| Chain | Five Solidity demo contracts and a viem adapter tested against a local non-SM FISCO BCOS v3.17.1 chain. |
| Treasurer | Separate in-memory proposal, funding, and monitor simulation; it is not connected to live bank accounts or chain settlement. |

The CLI integration driver has exercised shop checkout, the actual connector client, Gateway checks, simulated app approval and reservation, local FISCO settlement, shop confirmation, and app payment detail in one path.
An owner browser session has also completed a fresh agent pairing with an audit anchor on the local chain.
The completed payment path was a CLI run, not a live Claude shopping session or a bank-verifiable phone approval.
The separate limited Gateway fixture supports read, reject, and freeze demonstrations but cannot approve a card or move money.
The owner transfer and policy limit controls are built in the browser app and Gateway, with simulated owner approval in the local demo.
A real local FISCO cap write and refreshed owner browser acceptance of those controls remain pending.
The source includes a recording-stage command and a state-changing Hermes and FISCO acceptance driver for a separate disposable stack.
That driver completed a signed shop-to-app run: an Amber purchase showed one owner card, a Green ¥77.00 purchase settled on FISCO without a card, and Hermes denied a contradictory signed order without a wallet debit.
The run used simulated currency, merchants, and owner approval proof, and it did not involve a live Claude shopping session.

## Current owner controls

One pairing covers every chat in the named MCP host app; a second app name needs its own pairing and agent identity.
The app name is self-reported by the host, so this prototype does not prove the operating-system app behind it.
A connection idle for seven full days needs owner Re-approval for the same key before it can spend again.
An attended purchase first locks a non-spendable `pending_checkout` mandate, then presents one payment approval with the locked request and merchant-signed order when owner review is required.
Amber agents need approval for every purchase, and their first payment also needs a request number.
Green agents can auto-pay only within the owner's threshold after every deterministic, risk, and Guardian check passes.
Red agents cannot spend, and a separate owner freeze overrides every trust light.
An unattended or standing mandate can need approval when it is created.
The local demo can use a dedicated Nous Research Hermes Agent profile for one fixed Guardian review call, with no tools or carried conversation.
That zero-tool profile passed a live synthetic smoke test and the signed local shop-to-app acceptance run described above.
The path fails closed to owner review when Hermes or its isolation proof is unavailable.

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
The loopback Gateway keeps its private session, grants, mandates, payments, and receipt identity across an ordinary restart.
A fresh native deployment mints 866,000 fen to the simulated main account and begins with zero Agent Wallet balance, so the owner must fund the wallet in the app before creating a spending mandate.
The fresh Agent Wallet starts disabled and requires the signed-in owner's visibly simulated enable action before pairing or funding.
The [operator guide](scripts/local-demo-README.md) covers reset preflight, private archives, and recovery after a failed fresh start.

The individual components can also be explored separately.
Start the Expo web preview for the in-memory app walkthrough:

```sh
corepack pnpm --filter @webank/webank-app web
```

Start the mock storefront on loopback:

```sh
SHOP_INTERNAL_TOKEN=local-demo-token SHOP_OPERATOR_TOKEN=separate-local-operator-token corepack pnpm --filter @webank/shops exec next dev --hostname 127.0.0.1 --port 3001
```

The storefront is at `http://127.0.0.1:3001`, with local demo controls at `/demo`.
The `/demo` price and scenario actions require the separate local operator token.
The app's default simulation does not call this storefront or the chain.
See the [app](apps/webank-app/README.md), [shop](apps/shops/README.md), [Gateway](services/gateway/README.md), and [connector](agents/connector-mcp/README.md) READMEs for each separate mode.

On macOS arm64, `./scripts/chain-up.sh` starts a local four-node non-SM FISCO chain, downloads pinned official tooling on first use, and deploys the demo contracts.
`./scripts/chain-down.sh` stops the chain processes started by that operator.
The chain is optional for the default app and shop demonstrations; see the [chain operator guide](scripts/chain/README.md) before running it.

## Architecture and security boundary

The [architecture](docs/architecture.md) names each implemented interface and the adapters still supplied by test fixtures.
The connector stores a software private key in a local file, so an AI with the same user's filesystem access can read it.
The app has no production Secure Enclave action signer, and a successful local Face ID prompt is not a bank-verifiable payment approval.
The browser demo has been exercised, but the iOS app has not been built and tested on an iPhone for this release.
The limited Gateway fixture keeps state in memory; the opt-in loopback FISCO Gateway persists private local state but does not support replicas.
The local FISCO token is not e-CNY.
Do not use this prototype for real credentials, customer data, or payments.
