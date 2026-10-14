# Agent Wallet hackathon prototype

An independent prototype for the WeBank Fintechathon 2026, International Track, Topic F.
This repository is a hackathon project, not a WeBank product or a live banking service.

The product idea is a separate wallet for AI agents with user-set spending rules, approvals, and a visible record of decisions.
The current repository contains a browser simulation and a tested local FISCO BCOS compatibility spike.

## Browser prototype

[`prototype-work/`](prototype-work/) is a deterministic, interactive demonstration of five payment scenarios.
It shows a mock shop, a scripted shopping agent, and an Agent Wallet control panel sharing one local state.
The scenarios cover a purchase requiring approval, an automatic small purchase, a changed payee, a fire drill, and a frozen agent.

Run it locally with Node.js:

```sh
cd prototype-work
npm start
```

Open `http://127.0.0.1:4173` in a browser.
No package installation is required for this prototype.
The reset control clears the local demo state.

The agent, merchant registry, biometric approval, payment rail, receipts, and audit records are simulated in the browser.
The prototype does not connect to WeBank, Claude, a real bank account, e-CNY, or a blockchain, and it moves no funds.

## FISCO BCOS compatibility spike

[`spike-fisco/`](spike-fisco/) contains two Solidity test contracts, a TypeScript runner, and an [evidence report](spike-fisco/REPORT.md).
On a local four-node, non-SM FISCO BCOS v3.17.1 Air chain, the runner deployed both contracts through viem, submitted transactions, decoded events, and identified cap and freeze reverts.
The result supports using FISCO BCOS for the demo's TypeScript chain adapter.
The report records versions, transaction hashes, caveats, and reproduction steps.
This test does not demonstrate production banking, real e-CNY settlement, or a public explorer.

## License

The source in this repository is available under the [MIT License](LICENSE).
