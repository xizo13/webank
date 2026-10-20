# We-AIlowance

We-AIlowance is an Agent Wallet prototype for the WeBank Fintechathon 2026, International Track, Topic F.
It gives AI agents a separate allowance inside the user's bank account, under rules the bank enforces.
It is not a WeBank product, and no real money moves.
The currency, merchants and biometric step are simulated.

Our tagline is "We don't trust AI agents. We license them."

## How it works

1. The user turns on an Agent Wallet and moves money into it.
2. Each AI app pairs once, using a one-time request number and the owner's approval in the WeBank app.
3. Before shopping, the agent locks the user's intent: merchant, product barcode, variant and budget.
   We call this IntentLock.
4. The shop signs a payment request.
   The bank's Gateway checks it against the lock, the limits and the agent's Trust Light.
5. Amber agents need the owner for every purchase.
   Green agents can pay small amounts on their own.
   Red agents cannot spend.
6. Payments settle on a local FISCO BCOS chain.
   The contract enforces hard caps and records an audit anchor.

## Submission documents

- [Design rationale](docs/design-rationale.md): what the product is for, and why we used Hermes, a browser app and a local chain.
- [Technical documentation](docs/technical-documentation.md): architecture, core algorithms and security design.
- [Execution evidence](docs/execution-evidence.md): transaction hashes for payments, audit anchors and refusals.
- [Verification and known limits](docs/verification.md): test results, acceptance runs and open gaps.
- [Architecture](docs/architecture.md): each interface and the adapters still supplied by test fixtures.

The security self-assessment is submitted as a PDF with the presentation deck.

## What is in this repository

| Part | What it does |
| --- | --- |
| `apps/webank-app` | Expo (React Native) owner app, run in the browser: wallet, pairing, approvals, limits, Trust Lights and freeze |
| `apps/shops` | Mock Next.js shop and Shop MCP tools that issue Ed25519-signed payment requests |
| `agents/connector-mcp` | WeBank MCP connector for Claude: pairing, mandates and signed payment requests |
| `services/gateway` | Bank-side checks, approvals, Trust Lights, Guardian call, receipts and the read-only Bank Console |
| `services/guardian` | Fixed-call AI reviewer; the demo uses a zero-tool Nous Research Hermes Agent profile |
| `onchain`, `packages/chain` | Five Solidity contracts and a viem adapter for a local FISCO BCOS v3.17.1 chain |
| `services/treasurer`, `services/monitor` | Treasurer and monitor simulation; not connected to the live wallet |

## Quick start

You need Node.js 22 and Corepack, with the pinned pnpm 10.18.0.
Run the checks from the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
```

The `check` command runs Biome, the builds, the TypeScript checks and the default Vitest suite.
The local FISCO integration test is opt-in.

To run the full demo on macOS arm64 or Linux x86_64, follow the [local demo operator guide](scripts/local-demo-README.md).
Start it with `./scripts/local-demo-up.sh`, and stop it with `./scripts/local-demo-down.sh`.
This starts the app, the mock shop, the Gateway and a four-node chain on loopback.
The shop is at `http://127.0.0.1:3001`, and its demo controls are at `/demo`.
Native Windows is not supported as a chain host.

Each part can also run on its own.
See the [app](apps/webank-app/README.md), [shop](apps/shops/README.md), [Gateway](services/gateway/README.md), [connector](agents/connector-mcp/README.md) and [chain](scripts/chain/README.md) guides.

## Demo video

The submission video has three clips: setup and pairing, a successful Amber checkout, and a refused mandate that Claude corrects.
Green auto-pay and the Treasurer are not in the video.
A scripted run did test Green auto-pay: a ¥77 purchase settled without an approval card.
The same run showed Hermes denying a contradictory order.

## Limits

- The biometric step is simulated in the browser.
- The mobile apps are designed but not built.
  We intended iOS (Face ID or Touch ID with a Secure Enclave key) and Android (BiometricPrompt with an Android Keystore key), but neither has been built or tested on a device.
- The connector keeps its private key in a local file, so another process run by the same user could read it.
- The chain is local and permissioned, and its token is a test token, not e-CNY.
- The Treasurer is a tested simulation and does not move live funds.

Do not use this prototype for real credentials, customer data or payments.
