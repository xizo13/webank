# Spike Brief: Is FISCO BCOS compatible with our stack?

Paste everything below the line into a fresh agent session (e.g. Claude Code) opened in `~/Developer/webank`.

---

You are running a scoped technical spike for a hackathon team.
Read `README.md`, `techstack.md` (section 6) and `api-contracts.md` (section 7) in this folder first for context.

## Goal

Find out whether FISCO BCOS (WeBank's open-source permissioned blockchain) can be the main chain for our project, given that the rest of our stack is TypeScript (Node 22, viem, Foundry, Solidity).

## Success criteria (answer each with yes / no / partial + evidence)

1. A local FISCO BCOS chain runs on this Mac (Air version, 4 nodes, or the smallest supported setup), natively or in Docker.
2. We can compile and deploy plain Solidity contracts to it (check which `solc` versions FISCO BCOS supports; target 0.8.x).
3. We can send a transaction and read its result and events from TypeScript / Node.js, and get a transaction hash.
4. Ethereum JSON-RPC compatibility: can `viem` (or `ethers`) talk to it directly? If FISCO BCOS 3.x has an Ethereum-compatible (web3) RPC mode, try it. If not, find the best available Node.js path (official Node SDK, or a thin HTTP bridge to the Java SDK) and judge its maturity.
5. A contract `require` that fails produces a clean revert we can detect from TypeScript (our design relies on contract-enforced spending caps).
6. Optional, only if time remains: a block explorer or console to show transactions to judges (e.g. WeBASE), and whether national cryptography (SM2/SM3) mode works.

## Contracts to deploy

Put them in `spike-fisco/contracts/`.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract AuditAnchor {
    event Anchored(bytes32 indexed recordHash, uint8 kind, uint256 at);

    function anchor(bytes32 recordHash, uint8 kind) external {
        emit Anchored(recordHash, kind, block.timestamp);
    }
}

contract CappedWallet {
    address public gateway;
    uint256 public perPaymentCap;
    uint256 public balance;
    bool public frozen;

    event Paid(bytes32 indexed orderId, uint256 amount);

    constructor(uint256 cap) {
        gateway = msg.sender;
        perPaymentCap = cap;
        balance = 1000000;
    }

    function pay(bytes32 orderId, uint256 amount) external {
        require(msg.sender == gateway, "not gateway");
        require(!frozen, "frozen");
        require(amount <= perPaymentCap, "over cap");
        require(amount <= balance, "insufficient");
        balance -= amount;
        emit Paid(orderId, amount);
    }

    function freeze() external {
        require(msg.sender == gateway, "not gateway");
        frozen = true;
    }
}
```

## Test script (TypeScript, in `spike-fisco/scripts/`)

1. Deploy both contracts (`CappedWallet` with cap 30000).
2. Call `anchor(keccak256("hello"), 1)`; print the tx hash and the decoded `Anchored` event.
3. Call `pay(orderId, 27900)`; expect success and a `Paid` event.
4. Call `pay(orderId, 50000)`; expect a revert with reason "over cap"; show that TypeScript detects it.
5. Call `freeze()`, then `pay(orderId, 100)`; expect a revert with reason "frozen".
6. Print timings for each step (latency matters for our payment flow).

## Rules

- Use only official sources: the FISCO BCOS GitHub organisation (`github.com/FISCO-BCOS`), its official docs, or official Docker images. Note the exact versions you use.
- Put downloaded binaries and archives in `spike-fisco/vendor/`, separate from scripts you write.
- Do not use `sudo` or change system settings without asking me first.
- Do not touch any file outside `spike-fisco/` except to read the docs listed above.
- If a step fails after two genuinely different approaches, stop that path, record why, and move on.
- If criteria 1-3 all fail, stop the spike and report NO GO; do not keep searching for workarounds.

## Deliverable

`spike-fisco/REPORT.md` containing:

1. Verdict: GO (use FISCO BCOS as main chain), GO WITH BRIDGE (works, but needs a non-TypeScript bridge), or NO GO (use Base Sepolia).
2. Each success criterion: yes / no / partial, with the command or output that proves it.
3. Versions used and exact setup steps, so a teammate (or another agent) can reproduce it from the report alone.
4. How our TypeScript Gateway would call the chain (viem directly, Node SDK, or bridge), with a code snippet that worked.
5. Pain points, and anything that would make agents or teammates struggle when building on this chain (missing docs, non-standard tooling, manual steps that cannot be scripted).
6. How to show transaction hashes to judges (explorer, console, or screenshots).
