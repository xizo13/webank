# Agent Wallet MCP connector

This local stdio MCP server exposes `connect_webank`, `get_wallet_status`, `wait_for_approval`, `disconnect_webank`, `create_mandate`, `get_mandate_status`, `request_payment`, `get_payment_status`, and `list_my_payments` to an MCP host such as Claude.
It connects to `http://127.0.0.1:8787` by default, or to `WEBANK_GATEWAY_URL` when set.
The connector accepts plain HTTP only for a loopback Gateway; other Gateway origins must use HTTPS.

## Build and launch

From the workspace root after installing dependencies:

```sh
corepack pnpm --filter @webank/connector-mcp build
corepack pnpm --filter @webank/connector-mcp test
```

Configure the MCP host to launch `node /absolute/path/to/agents/connector-mcp/dist/index.js` with stdio.
The host must send a nonempty `clientInfo.name` during MCP initialization.
The connector derives `app_` plus the SHA-256 digest of that exact UTF-8 name and uses it for the app's credential file and owner consent.
Changing the MCP client version or starting another chat with the same name keeps the same app identity.
Changing the name starts a separate identity that needs its own owner-approved pairing.
Set `WEBANK_GATEWAY_URL` to the reachable Gateway origin when it is not the default.
There is no standalone full-payment Gateway listener at the default address in this release.
The limited `demo` Gateway fixture listens on port 3002, provides read, reject, and freeze demonstrations, and cannot approve a card or pay.
The separate opt-in `local-demo` listener also uses port 3002 and can settle simulated currency on a local FISCO chain after an explicitly simulated app approval.
The [operator guide](../../scripts/local-demo-README.md) starts that loopback composition.

## Claude Desktop extension

Build the self-contained macOS MCP bundle from the repository root:

```sh
corepack pnpm --filter @webank/connector-mcp build:extension
```

The output is `agents/connector-mcp/release/webank-agent-wallet-0.1.0.mcpb`.
Start the local demo Gateway first, then open this file with Claude Desktop or use its Extensions screen to install the file.
The bundle supplies the stdio server, its dependencies, and the local funded-demo Gateway URL `http://127.0.0.1:3002`; no JSON edit is needed.
The extension uses the MCP host's initialized app name for its credential namespace.
The same credential rules apply to the bundled extension and the manual stdio setup.
Restart Claude Desktop after installation and check that the nine WeBank tools appear before pairing.
If a manual `webank` MCP server is already registered, disable that duplicate entry in Claude Desktop before using the extension.
The extension adds only the WeBank connector; install the shop MCP server separately when a shopping demo needs it.
The package contains no agent credential, owner session, bank key, or runtime state.
The generated bundle includes full license files for its bundled third-party packages under `notices/licenses/`.
The [MCPB specification](https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md) defines this extension format.

For a manual fallback, build the connector and add this entry to `mcpServers` in `~/Library/Application Support/Claude/claude_desktop_config.json`, replacing the placeholder with the absolute checkout path:

```json
{
  "webank": {
    "command": "node",
    "args": ["/ABSOLUTE/PATH/TO/CHECKOUT/agents/connector-mcp/dist/index.js"],
    "env": { "WEBANK_GATEWAY_URL": "http://127.0.0.1:3002" }
  }
}
```

Merge that entry into the existing `mcpServers` object without replacing other servers, save valid JSON, fully quit Claude Desktop, and reopen it.
The manual entry and the extension are alternatives; keeping both enabled gives duplicate WeBank tools.
Keep the separate BaoTao Shop MCP server registered for shopping; the [shop guide](../../apps/shops/README.md) describes its stdio command and `SHOP_URL=http://127.0.0.1:3001` setting.

## Implemented request flow

`connect_webank` creates a P-256 key and requests device-code pairing with `wallet:pay`, `wallet:mandate`, and `wallet:history:self` scopes.
The Gateway implements device authorization, a ten-minute pairing window, scoped access tokens, and rotating refresh tokens.
The connector polls for consent and saves the resulting credentials locally.
`get_wallet_status` and `connect_webank` verify Gateway state with a fresh key-bound signature before claiming connection.
Both tools report `reauthorization_required` after seven full days without a completed payment or owner authorization.
The owner must use Re-approve connection in the WeBank app for that exact app and key.
Once the owner does so, the connector makes a signed token renewal request with the existing key and keeps the existing licence.
Status checks, new chats, and token refreshes do not extend the seven-day deadline.
`wait_for_approval` long-polls pairing, mandate, or payment approval for up to 55 seconds.
`disconnect_webank` revokes the key at Gateway before deleting local credentials.
`connect_webank({ re_pair: true })` revokes a verifiable old key, then starts a fresh independent identity with a new key and owner-approved pairing.
If the stored old key cannot be verified, the connector quarantines it and starts the new pairing only on an explicit `re_pair: true` request.
That path cannot revoke an old active agent whose key is lost; the owner must Delete agent in the WeBank app to remove its authority.
After a funded `--fresh` reset, the launcher leaves the old local connector credential untouched even though the prior Gateway identity has been archived.
Call `connect_webank({ re_pair: true })` to start pairing against the new Gateway and wait for the owner's app consent before creating a mandate.
The connector cannot restore a trust light or unfreeze itself through this flow.
Frozen or Red agents cannot spend until the owner's separate in-app recovery.
The connector has no Unfreeze, Return to Amber, Delete agent, policy-write, or consent-selection tool.
It signs each authenticated Gateway request over the method, path, content digest, and idempotency key using RFC 9421 style headers with a fresh nonce.
The Gateway checks the signature, scope, time window, and nonce before processing the request.
Mandate and payment tools return pending, paid, or denied status according to the Gateway response, and the status and history tools query only this agent's records.
Check wallet status and call `create_mandate` from the user's request before any shop tool.
An attended one-time purchase uses `approval_timing: "payment"` by default and returns `pending_checkout` with no approval card or spending authority.
Shop within that locked scope, then send the shop's unchanged signed `payment_request` URI with the same mandate ID to `request_payment`.
An Amber agent's `awaiting_user` payment response includes `payment_id` and `approval_id`; the user reviews that single payment card before funds move.
The first Amber payment also uses the zero-trust request-number ceremony.
A Green agent can receive `paid` with a receipt automatically below the owner's threshold after all checks pass.
Above that threshold, Green receives one `awaiting_user` payment card.
Red cannot spend until the owner reviews its history and returns it to Amber in the WeBank app.
For a standing or unattended task, explicitly choose `approval_timing: "upfront"`.
If an upfront mandate returns `pending_user`, wait for its approval and confirm it is active before shopping.
Gateway verifies the request against the registered merchant key, signed amount, line total, expiry, and locked mandate fields.
The `create_mandate` MCP schema comes from the shared contracts and gives complete open, product, and listing examples.
It requires `amount_range`, `categories`, `budget`, `recurrence`, and `execution_window` constraints.
Its money values are positive integer CNY fen, so ¥279.00 is `{ "amount": 27900, "currency": "CNY" }`.
Omitting `allowed_merchants` or using `merchant_ids: null` allows any registered merchant, subject to bank policy.

Pairing, the first upfront mandate approval, and the first payment approval return a six-digit request number to the MCP host and attempt a local macOS notification.
An attended `pending_checkout` mandate returns no request number because it has no approval card.
If the notification cannot be delivered, the result says `notification_delivered: false` and the pending action still needs user review.
The app's production action-bound biometric verifier is not implemented, so this code does not establish a live user-approved payment path.

## Test and security limits

The connector tests enumerate all nine tools through the MCP protocol against a contract-shaped HTTP stub and exercise status, approval wait, and disconnect through Gateway HTTP.
An integrated test also sends mandate and payment calls through MCP to Gateway HTTP and checks pending approval and policy denials.
It checks key use, signed requests, pending approval, own history, notification behavior, and nonce replay rejection.
Gateway HTTP tests separately exercise device authorization and verify requests signed by the connector helper.
The CLI integration driver has also used this connector client against the loopback Gateway, mock shop, and local FISCO chain to complete a test-token purchase and read the receipt.
A live Claude pairing and payment through a secure phone approval have not been demonstrated.

The current demo stores each app's private key and tokens in `~/.config/webank-agent-wallet/apps/app_<sha256>.json` with a mode `0600` file inside a mode `0700` `apps` directory.
The hash is computed from the exact MCP initialize `clientInfo.name`; tool arguments cannot select an app identity.
Set `WEBANK_CONNECTOR_CREDENTIALS` to choose another base path; app files then live in an `apps` directory beside that base path.
An older unlabelled `connector.json` is preserved and is never imported automatically into an app identity.
Tool results omit private keys and tokens, but a same-user AI with shell or filesystem access can read this software key.
The MCP app name is self-reported by the host, so this demo does not prove which operating-system app supplied it.
The planned non-exportable hardware key is outside this implementation.
Use only local test identities and funds with this connector.
