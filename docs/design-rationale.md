# Design Rationale - We-AIlowance

Status: submitted 2026-10-20.
This document explains what We-AIlowance is for and why the prototype is built the way it is: which parts are real, which are simulated, and why.
For how it works, see the [technical documentation](technical-documentation.md); for what has been checked, see [verification and known limits](verification.md).

## 1. What the product is for

AI agents can already research and compare products, but paying is all or nothing today: hand the agent a card and hope, or approve every step yourself.
We-AIlowance is an Agent Wallet designed for WeBank: a separate allowance inside the user's bank account that AI agents can spend from, under rules the bank enforces rather than the AI.

The design rests on four ideas:

1. **The bank is the control point.** Agents and shops only make requests; WeBank checks them in code, and the user approves when required.
   One bank can govern every agent, on every payment rail, with one freeze button.
2. **Intent is locked before shopping (IntentLock).** The merchant, product barcode, variant and budget are fixed when the user asks, so a fooled agent cannot change what gets paid for.
3. **Agents earn autonomy (Trust Lights).** A new agent is Amber and needs the user for every purchase; a clean record can make it Green for small purchases within the user's threshold; a failed bank Scam Drill or repeated flags turn it Red.
4. **No single layer can move money alone (Triple Lock).** Deterministic checks, the user's approval or grant, and hard caps in the smart contract must all agree.

Tagline: "We don't trust AI agents. We license them."

## 2. Why each part of the prototype is built this way

### 2.1 Hermes as a stand-in for WeBank's internal AI reviewer

The Guardian is an AI reviewer inside the bank that reads one structured purchase and answers whether it matches what the user asked for.
In production this would be WeBank's own in-house model; for the prototype we used Nous Research Hermes Agent to play that role.

Why Hermes:

- **It can run inside the bank.** Hermes is open source and runs on our own machine, so purchase data does not leave the "bank" side to a third-party chat service, as it would not in production.
- **It is a different model from the shopping agent.** The shopping agent (Claude) should never review its own purchases; a separate model reduces the chance that one prompt injection fools both.
- **It can be locked down.** We run it with a dedicated profile that has no tools, no memory, no skills, no MCP servers and no plugins, called once per decision with no conversation history.

How it is constrained, whichever model fills the slot:

- One structured input; one of three outputs: `pass`, `step_up` (ask the user) or `deny`.
- It can only make a decision stricter; it can never approve a payment, change a limit, or change a Trust Light.
- Any timeout, refusal, malformed answer or unknown tool status fails closed to the user.

**Swappable by design.** The Gateway reaches the Guardian through one transport function (`GuardianTransport` in `services/guardian`), so WeBank could replace Hermes with its own model without changing the payment rules.

### 2.2 A browser app instead of an iPhone app

The WeBank app is written in Expo (React Native), the same codebase that targets iOS, but the prototype runs it as a web export in the browser.

Why:

- **Anyone can reproduce it.** Every component runs on one computer on loopback; judges can run the demo without an Apple developer account, device provisioning, or an iPhone.
- **The security lives elsewhere.** Approvals, limits, Trust Lights and settlement are enforced by the Gateway and the smart contract, not by the app screen, so the browser app exercises the same rules a phone app would.
- **Honest about biometrics.** Real Face ID or Touch ID signing needs a native build tested on a device, which we did not complete for this release.
  The browser shows a clearly labelled simulated biometric step instead of pretending.

Production design: a native iOS app where each approval is signed by a biometric-only Secure Enclave key bound to the exact action, so a screen tap alone cannot approve a payment.
The iOS source has not been built and tested on an iPhone for this release.

### 2.3 A local FISCO BCOS chain and simulated e-CNY

- **FISCO BCOS** is the open-source permissioned blockchain created by WeBank and partners, so settlement runs on the bank's own kind of infrastructure.
- **Local and permissioned:** a four-node local chain keeps the demo reproducible offline; hashes are verifiable through that chain's RPC, not a public explorer.
- **Simulated e-CNY (`ECnySim`):** real e-CNY is not available to us, so a test token stands in for the money.
- **Why a chain at all:** the AgentWallet contract enforces hard caps and freeze independently of the Gateway, so even a faulty or compromised server cannot overspend, and every payment decision that reaches the decision pipeline is anchored for a tamper-evident audit trail.

### 2.4 Mock shops

Real merchant integration is out of scope, so the prototype uses mock shops.
Each shop signs its payment request with Ed25519, the way a merchant's payment QR is issued; merchants keep their own checkout and only need to sign the request.
The shops also host demo controls (price changes, a poisoned listing, a bank-only drill decoy) so attacks can be reproduced.

### 2.5 Claude as the first supported agent

Claude connects through the Model Context Protocol (MCP), an open standard, so any MCP client can use the same WeBank connector.
Each client app gets its own identity, key and Trust Light (Agent Passport), and pairs once with a one-time request number shown on the computer and entered in the WeBank app.

## 3. Real, simulated, and not built

| Part | Status in this release |
|---|---|
| Gateway checks, IntentLock, Trust Lights, freeze, idle re-approval | Real, tested |
| Shop-signed payment requests and agent-signed requests (RFC 9421, P-256) | Real, tested |
| Settlement, hard caps and audit anchors on FISCO BCOS | Real, on a local permissioned chain |
| Hermes Guardian as a zero-tool fixed call | Real, local; scripted shop-to-app run passed with a Guardian pass and a Guardian denial; live Claude-session acceptance pending |
| Money | Simulated e-CNY test token |
| Merchants | Mock shops |
| Biometric approval | Simulated and labelled in the browser app |
| Green fast-forward in the demo | Labelled simulated owner control; it does not fabricate purchase history |
| Treasurer (just-in-time funding) and its monitor | Tested simulation, not connected to the live wallet |
| Native iOS app with Secure Enclave signing | Designed; not built and tested for this release |
| Push payment notifications, refunds routed by reason | Designed; not built |
