# Agent Wallet MCP connector

This local stdio MCP server exposes `connect_webank`, `create_mandate`, `request_payment`, `get_payment_status`, and `list_my_payments` to an MCP host such as Claude.
It connects to `http://127.0.0.1:8787` by default, or to `WEBANK_GATEWAY_URL` when set.
The connector accepts plain HTTP only for a loopback Gateway; other Gateway origins must use HTTPS.

## Build and launch

From the workspace root after installing dependencies:

```sh
corepack pnpm --filter @webank/connector-mcp build
corepack pnpm --filter @webank/connector-mcp test
```

Configure the MCP host to launch `node /absolute/path/to/agents/connector-mcp/dist/index.js` with stdio.
Set `WEBANK_GATEWAY_URL` to the reachable Gateway origin when it is not the default.
There is no standalone full-payment Gateway listener at the default address in this release.
The limited `demo` Gateway fixture listens on port 3002, provides read, reject, and freeze demonstrations, and cannot approve a card or pay.
The separate opt-in `local-demo` listener also uses port 3002 and can settle simulated currency on a local FISCO chain after an explicitly simulated app approval.
The [operator guide](../../scripts/local-demo-README.md) starts that loopback composition.

## Implemented request flow

`connect_webank` creates a P-256 key and requests device-code pairing with `wallet:pay`, `wallet:mandate`, and `wallet:history:self` scopes.
The Gateway implements device authorization, a ten-minute pairing window, scoped access tokens, and rotating refresh tokens.
The connector polls for consent and saves the resulting credentials locally.
It signs each authenticated Gateway request over the method, path, content digest, and idempotency key using RFC 9421 style headers with a fresh nonce.
The Gateway checks the signature, scope, time window, and nonce before processing the request.
Mandate and payment tools return pending, paid, or denied status according to the Gateway response, and the status and history tools query only this agent's records.

Pairing and the first payment return a six-digit request number to the MCP host and attempt a local macOS notification.
If the notification cannot be delivered, the result says `notification_delivered: false` and the pending action still needs user review.
The app's production action-bound biometric verifier is not implemented, so this code does not establish a live user-approved payment path.

## Test and security limits

The connector test calls all five tools through the MCP protocol against a contract-shaped HTTP stub.
It checks key use, signed requests, pending approval, own history, notification behavior, and nonce replay rejection.
Gateway HTTP tests separately exercise device authorization and verify requests signed by the connector helper.
The CLI integration driver has also used this connector client against the loopback Gateway, mock shop, and local FISCO chain to complete a test-token purchase and read the receipt.
A live Claude pairing and payment through a secure phone approval have not been demonstrated.

The current demo stores the private key and tokens in `~/.config/webank-agent-wallet/connector.json` with a mode `0600` file inside a mode `0700` directory.
Set `WEBANK_CONNECTOR_CREDENTIALS` to choose another local file.
Tool results omit private keys and tokens, but a same-user AI with shell or filesystem access can read this software key.
The planned non-exportable hardware key is outside this implementation.
Use only local test identities and funds with this connector.
