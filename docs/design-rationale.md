# Design Rationale - We-AIlowance

Status: submitted 2026-10-20.
This document explains what We-AIlowance is for and why the prototype is built the way it is.
For how it works, see the [technical documentation](technical-documentation.md).
For what has been checked, see [verification and known limits](verification.md).

## 1. What the product is for

AI agents can already research and compare products for people.
Paying is still all or nothing: the user either hands the agent a card or approves every step.
We-AIlowance is an Agent Wallet designed for WeBank.
It is a separate allowance inside the user's bank account that AI agents can spend from, under rules the bank enforces.

The design rests on four ideas:

1. **The bank is the control point.** Agents and shops only make requests, and WeBank decides.
   One bank can govern every agent on every payment rail.
2. **IntentLock.** The merchant, product barcode, variant and budget are locked when the user asks.
   A fooled agent cannot change what gets paid for.
3. **Trust Lights.** A new agent is Amber and needs the user for every purchase.
   A clean record can make it Green for small purchases within the user's threshold.
   A failed Scam Drill or repeated flags turn it Red.
4. **Triple Lock.** The bank's checks, the user's approval and the contract's hard caps must all agree before money moves.

Our tagline is "We don't trust AI agents. We license them."

## 2. Why the prototype is built this way

### 2.1 Hermes stands in for WeBank's internal AI reviewer

The Guardian is an AI reviewer inside the bank.
It reads one purchase and checks that it matches what the user asked for.
In production, this would be WeBank's own model.
For the prototype, Nous Research Hermes Agent plays that role.

We chose Hermes for three reasons:

- It is open source and runs on our own machine, so purchase data stays on the bank side.
- It is a different model from the shopping agent, so one prompt injection is less likely to fool both.
- It can be locked down.
  Our profile has no tools, memory, skills, MCP servers or plugins, and each call carries no history.

Whichever model fills the slot, the same limits apply.
It receives one structured input and returns `pass`, `step_up` or `deny`.
It can only make a decision stricter; it can never approve a payment, change a limit or change a Trust Light.
A timeout, refusal or malformed answer sends the payment to the user.

The Guardian is swappable.
The Gateway calls it through one transport function (`GuardianTransport` in `services/guardian`).
WeBank could replace Hermes with its own model without changing any payment rule.

### 2.2 The app runs in a browser instead of on a phone

The WeBank app is written in Expo (React Native), which also targets iOS and Android.
For the prototype, it runs as a web export in the browser.

We chose the browser for three reasons:

- Anyone can reproduce the demo on one computer, without a developer account or a phone.
- The security rules live in the Gateway and the smart contract, not in the app screen.
  The browser app exercises the same rules a phone app would.
- Real biometric approval needs a native build tested on a device, which we did not complete.
  The browser shows a clearly labelled simulated biometric step instead.

In production, each approval would be signed on the phone by a key that only unlocks with the owner's biometric, bound to the exact action.
On iOS, this is Face ID or Touch ID with a Secure Enclave key.
On Android, this is BiometricPrompt with an Android Keystore key, backed by StrongBox or the device's secure hardware.
We intended both, but neither mobile build has been made or tested on a device for this release.

### 2.3 Settlement runs on a local FISCO BCOS chain

FISCO BCOS is the open-source permissioned blockchain created by WeBank and its partners.
We run a four-node chain locally so the demo works offline and can be reproduced.
Its hashes can be checked through the chain's RPC, not a public explorer.
The money is a simulated e-CNY test token (`ECnySim`), because real e-CNY is not available to us.

The chain does three jobs.
The AgentWallet contract enforces hard caps and freeze, so even a faulty server cannot overspend.
The token transfer is the payment itself.
Payment decisions that reach the decision pipeline are anchored on chain as a tamper-evident audit trail.

### 2.4 The shops are mocks

Real merchant integration is out of scope.
Each mock shop signs its payment request with Ed25519, much as a merchant issues a payment QR.
Merchants keep their own checkout and only need to sign the request.
The shops also host demo controls, such as price changes, a poisoned listing and a bank-only drill decoy.

### 2.5 Claude is the first supported agent

Claude connects through the Model Context Protocol (MCP), an open standard.
Any MCP client can use the same WeBank connector.
Each client app gets its own identity, key and Trust Light, which we call the Agent Passport.
An app pairs once, using a one-time request number shown on the computer and entered in the WeBank app.

## 3. Real, simulated and not built

| Part | Status in this release |
|---|---|
| Gateway checks, IntentLock, Trust Lights, freeze and idle re-approval | Real and tested |
| Shop-signed and agent-signed requests (Ed25519; RFC 9421 with P-256) | Real and tested |
| Settlement, hard caps and audit anchors on FISCO BCOS | Real, on a local permissioned chain |
| Hermes Guardian as a zero-tool fixed call | Real and local; a scripted shop-to-app run passed with a Guardian pass and a denial; a live Claude session is pending |
| Money | Simulated e-CNY test token |
| Merchants | Mock shops |
| Biometric approval | Simulated and labelled in the browser app |
| Green fast-forward in the demo | A labelled simulated owner control; it does not invent purchase history |
| Treasurer and its monitor | Tested simulation, not connected to the live wallet |
| Native iOS and Android apps with hardware-backed biometric signing | Designed, not built |
| Payment notifications and refunds routed by reason | Designed, not built |
