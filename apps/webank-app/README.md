# WeBank Agent Wallet app

Expo React Native source for the Agent Wallet demonstration.
The verified interactive target is a browser web export.
The iOS configuration is present, but an iOS development build and on-device behavior have not been verified for this release.
It uses a local simulation by default.
No real money moves and the default in-memory simulation creates no chain transaction.
In the opt-in loopback composition, the Gateway can submit test-token transactions to a local permissioned chain; those are still not real money.

## Run

From the repository root, install the workspace dependencies with `corepack pnpm install`.
Run `corepack pnpm --filter @webank/webank-app web` for the browser preview.
`corepack pnpm --filter @webank/webank-app start` starts the Expo development server, but this release has no tested iPhone build.
An iOS biometric prompt would require a development build with Face ID permission, and it would still not provide a bank-verifiable action signature.

To try Gateway mode, set `EXPO_PUBLIC_GATEWAY_URL` to a reachable Gateway origin before starting Expo and use an authenticated app session.
For the explicit loopback demo, set `EXPO_PUBLIC_GATEWAY_URL=http://127.0.0.1:3002` and `EXPO_PUBLIC_LOCAL_DEMO=1`, then rebuild the web export with `expo export --platform web --clear` after changing these variables.
The local Gateway must separately run with `WEBANK_LOCAL_DEMO=1` and `WEBANK_DEMO_APPROVALS=1`, outside production.
The app asks for the private bootstrap login token at the path printed by the local-demo launcher and clears its input after each attempt.
The token is not consumed by login, remains valid across an ordinary restart, and rotates when `--fresh` archives the Gateway identity.
This web-only path sends `simulated-local-approval` with the exact card action hash and the connector's six-digit request number when required.
Every local approval is visibly simulated, and no Face ID or Secure Enclave signature is created.
Gateway mode without the explicit local flag and exact `127.0.0.1` HTTP origin keeps approval locked.
The app polls Gateway every three seconds for agents, pending approvals, and payment history, and polls an open payment for its decision and receipt.
It looks up connector pairing consent by code, then shows claimed pending and expired pairings with a countdown.
Each approved pairing creates a new independent Amber agent identity for the MCP host's self-reported app name.
The consent card explains that the grant covers every chat in that app and shows the provider, scopes, pairing-code deadline, and shorter request-number deadline.
The Agents screen shows Amber, Green, or Red trust with a reason, plus a separate owner freeze state.
It offers Freeze, Unfreeze, Re-approve connection after seven days idle, Return to Amber after reviewing trust evidence, and Delete agent controls.
The owner can use a clearly labelled local demo control that fast-forwards an agent to Green.
This is a simulated override, not an earned qualification, and it does not fabricate a clean purchase history.
In the loopback demo, these owner actions send the explicit simulated approval proof: agent and payment approvals, funding, spending-limit changes that raise any limit, Unfreeze, Re-approve connection, Return to Amber, and the Green override.
Returning wallet balance to the main account, spending-limit changes that only lower limits, Freeze, Delete agent, rejecting or denying a request, and starting or stopping the demo drill rely on the authenticated owner session without any biometric or simulated proof.
None of these is a bank-verifiable biometric action.
Delete confirms the named agent and retains history.
In Gateway mode, Home and Wallet read the simulated main-account and separate Agent Wallet balances from `GET /v1/app/home` with a chain block and observation time.
Stale or unavailable readings disable funding and sweep actions.
The Wallet screen includes the owner's spending-limit controls, which read and change policy through the Gateway.
Editing is available only while the saved policy and the observed contract caps agree; a mismatch, an unreadable cap, or a pending change keeps the editor locked.
In explicit loopback demo mode, the owner can enter an exact CNY amount, review the fixed source and destination, and perform a visibly simulated biometric confirmation before submitting the action-bound funding challenge.
Funding history displays only the Gateway's verified completed transaction hash and block; uncertain transfers remain pending for reconciliation and are not retried with a new funding ID.
The owner can return only the Gateway-reported available wallet balance to the fixed main account.
Return history shows pending reconciliation and verified chain transaction evidence after settlement.
The app does not submit live approvals until it can register and use a biometric-only Secure Enclave key for an action-bound signature.
Do not interpret a successful local Face ID prompt as a bank-verifiable approval signature.
The `src/deviceSigner.ts` interface is fail closed and has no native implementation yet.

## Current approval behavior

An attended one-time mandate is locked as `pending_checkout` before shopping and has no spending authority or approval card.
After the shop signs the exact order, the Gateway checks it against that mandate and can present one composite payment card with the locked intent and signed order facts.
Amber agents need owner approval for every purchase, with a request number on the first payment.
Eligible Green purchases within the owner's threshold can proceed after all checks without a card; larger or uncertain purchases require the owner.
Red agents cannot spend until the owner reviews their trust events and returns them to Amber.
An upfront mandate for an unattended task can require its own approval when created.
Approvals in the local demo use simulated proof where listed above, and none of it is a bank-verifiable biometric signature.
The local composition can reveal a decoy listing and turn an agent Red, but it has no authenticated drill-pass service, so earned promotion from Amber to Green cannot be demonstrated end to end locally.

## Demo path

1. Enable the wallet from Home and complete the explicitly simulated biometric step on web.
2. Move ¥1,000 into the simulated wallet.
3. Open Agents and connect Claude.
   The in-memory fixture pairing code is `WQ7K-3MXP`.
4. On the consent card, enter the in-memory fixture's six-digit request number `481926`, then complete the fresh demo biometric step.
5. Open Demo controls on Home and queue the first payment.
   Enter the in-memory fixture's request number `739204` and complete a separate biometric step.
6. Inspect the sample receipt in Activity.
7. Simulate the poisoned listing from Demo controls and inspect the blocked receipt.
8. Freeze Claude in Agents and verify that another payment request cannot be queued.

The request numbers above represent output from the in-memory connector fixture.
The app approval cards do not display them.
The funded loopback Gateway generates different pairing codes and request numbers for each request; read them from the connector, not from this fixture walkthrough.
After a fresh funded deployment, the Agent Wallet starts at zero and must be funded from the simulated main account before a mandate can reserve money.
Three incorrect entries cancel a request.
Pairing consent expires after 10 minutes, and payment approval expires after 180 seconds.

## Current limits

The default path is an in-memory prototype.
Reloading resets it, and the sample receipts have no transaction hash.
The browser simulation is useful for navigation and state checks, not for proving Face ID or Secure Enclave behavior.
An iPhone development build, on-device testing, and Gateway device-key registration are required before real biometric approval can be tested end to end.
The Gateway has no standalone production app-session listener yet, so the live route checks currently use Gateway fixtures and app client tests.
