# WeBank Agent Wallet app

Expo iOS prototype for the Agent Wallet demonstration.
It uses a local simulation by default.
No real money moves and no chain transaction is created by the demo controls.

## Run

From `product-work`, install the workspace dependencies with `corepack pnpm install`.
Run `corepack pnpm --filter @webank/webank-app web` for the browser preview.
Run `corepack pnpm --filter @webank/webank-app start` for Expo on a supported iPhone build.
The iOS biometric prompt requires a development build with Face ID permission.

To try Gateway mode, set `EXPO_PUBLIC_GATEWAY_URL` to a reachable Gateway origin before starting Expo and use an authenticated app session.
For the explicit loopback demo, set `EXPO_PUBLIC_GATEWAY_URL=http://127.0.0.1:3002` and `EXPO_PUBLIC_LOCAL_DEMO=1`, then rebuild the web export with `expo export --platform web --clear` after changing these variables.
The local Gateway must separately run with `WEBANK_LOCAL_DEMO=1` and `WEBANK_DEMO_APPROVALS=1`, outside production.
The app asks for the one-time app login token printed by that Gateway and clears it after each attempt.
This web-only path sends `simulated-local-approval` with the exact card action hash and the connector's six-digit request number when required.
Every local approval is visibly simulated, and no Face ID or Secure Enclave signature is created.
Gateway mode without the explicit local flag and exact `127.0.0.1` HTTP origin keeps approval locked.
The app polls Gateway every three seconds for agents, pending approvals, and payment history, and polls an open payment for its decision and receipt.
It looks up connector pairing consent by code, can deny pairing or payment approvals, and can freeze one connected agent.
The wallet balance and limits remain clearly marked simulations in Gateway mode because those app read routes are not connected.
The app does not submit live approvals until it can register and use a biometric-only Secure Enclave key for an action-bound signature.
Do not interpret a successful local Face ID prompt as a bank-verifiable approval signature.
The `src/deviceSigner.ts` interface is fail closed and has no native implementation yet.

## Demo path

1. Enable the wallet from Home and complete the explicitly simulated biometric step on web.
2. Move ¥1,000 into the simulated wallet.
3. Open Agents and connect Claude.
   The demo connector pairing code is `WQ7K-3MXP`.
4. On the consent card, enter the connector's six-digit request number `481926`, then complete the fresh demo biometric step.
5. Open Demo controls on Home and queue the first payment.
   Enter the connector's request number `739204` and complete a separate biometric step.
6. Inspect the sample receipt in Activity.
7. Simulate the poisoned listing from Demo controls and inspect the blocked receipt.
8. Freeze Claude in Agents and verify that another payment request cannot be queued.

The request numbers above represent output from the external connector fixture.
The app approval cards do not display them.
Three incorrect entries cancel a request.
Pairing consent expires after 10 minutes, and payment approval expires after 180 seconds.

## Current limits

The default path is an in-memory prototype.
Reloading resets it, and the sample receipts have no transaction hash.
The browser simulation is useful for navigation and state checks, not for proving Face ID or Secure Enclave behavior.
An iPhone development build and Gateway device-key registration are required before real biometric approval can be tested end to end.
The Gateway has no standalone production app-session listener yet, so the live route checks currently use Gateway fixtures and app client tests.
