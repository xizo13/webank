# Execution Evidence - We-AIlowance (Topic F)

Status: submitted 2026-10-20; hashes 1 to 4 re-checked on the running local chain through its Web3 RPC (`eth_getTransactionReceipt`), status `0x1`.

## What these hashes are

All transactions below are real transactions on a local, permissioned FISCO BCOS v3.17.1 chain (four nodes, non-SM, chain ID 20200), the open-source blockchain created by WeBank and partners.
The token moved is `ECnySim`, a simulated e-CNY test token; no real money, real merchant or real e-CNY is involved.
Merchants are mock shops.
Because the chain is permissioned and local, these hashes cannot be opened in a public explorer; each one can be verified by querying the chain's Web3 RPC with `eth_getTransactionReceipt`, as described below.

## Transactions

| # | What happened | Transaction hash | Block | Contract and event | Result |
|---|---|---|---|---|---|
| 1 | Claude (via Claude Code and the WeBank connector) bought one black Nova Quiet 3 headphones, ¥279 + ¥5 shipping = ¥284, with one owner payment approval (Amber), on 2026-10-20 | `0x2400800f055c1aafc1a882bf770da6026975d801830ed3cbbf8207311a769197` | 553 (`0x229`) | AgentWallet, `Paid` | Status `0x1` |
| 2 | Audit anchor for payment 1 (receipt `rcp_e1aeee8925314319b6fa1194bdf2374e`, payment `pay_418c68168b06497fac50e98dfede9ff2`, order `ord_8de721ec070548f4b4cf3945df342605`, mandate `mdt_14987332dde542d5b2fcdcf2f16ea856`) | `0xc081e63eaedf53a06468b9f3b1e7a6e8cb8b622054f3e35b2d66ddceee39102b` | 554 (`0x22a`) | AuditAnchor, `Anchored` | Status `0x1` |
| 3 | Claude bought one BaoTao Shop service voucher, ¥20, with one owner payment approval (Amber), after correcting a refused mandate, on 2026-10-20 | `0xc561e409cd0b5bed8f6def424e8f0ce5d383306ee8eda9076fd2b6daee5a09d8` | 567 (`0x237`) | AgentWallet, `Paid` | Status `0x1` |
| 4 | Audit anchor for payment 3 (receipt `rcp_3d6d340e9ba04004b32432d8e1f40093`) | `0xbeda6f9cf712f18e37aea1dadbd81354b4f1681659a2ff80b583c439b1d26b04` | 568 (`0x238`) | AuditAnchor, `Anchored` | Status `0x1` |
| 5 | Earlier ¥284 purchase (2026-10-15 run): Claude (via Claude Code and the WeBank connector) bought one black Nova Quiet 3 headphones, ¥279 + ¥5 shipping = ¥284, after a user-approved mandate and a user-approved payment | `0xc3f0a84ee3d7b7d03e7dc0ee27deb1ed057c603694c2fc638bc9592b27f27bee` | 347 | AgentWallet, `Paid` | Status `0x1` |
| 6 | Audit anchor for payment 5 (decision record hash) | `0xda1a118608beccb2ef5633d4a6506f4c7dd113f5734505d78f11edcdde4c43d8` | 348 | AuditAnchor, `Anchored` | Status `0x1` |
| 7 | Earlier Claude purchase in the wave 1 run (payment) | `0xba5a9eaa4acf2705e5e25fadf73a6861d30947bf93b8d4f4c7eea3eeefd2a616` | 178 (`0xb2`) | AgentWallet, `Paid` | Status `0x1` |
| 8 | Audit anchor for payment 7 | `0x7c6d1bb06243c7c9b1651c17f783f1f14474077836019c246dd9ae82cd89bdf9` | 179 (`0xb3`) | AuditAnchor, `Anchored` | Status `0x1` |
| 9 | Integration-driver purchase, ¥279, through shop checkout, connector signing, Gateway checks and settlement | `0x44ddf09818149eb3bbd6ac14667216383acfd631b78fbd8787828616fcf9b108` | | AgentWallet, `Paid` | Successful |
| 10 | Audit anchor for payment 9 | `0xf4166fb49abd4bf8c227f0103108cd55c02a3169e78cfcb80d801b1d32ec1010` | | AuditAnchor | Successful |
| 11 | A person paid a shop QR from the main account (coffee, ¥88 + ¥5 shipping = ¥93); the Agent Wallet was untouched | `0xc49b0b9acf2b09610eaa8079378efa847b7fab5f6cf916dd51e20a1ef1ccc7d2` | 358 | ECnySim, `Transfer` (no AgentWallet `Paid`) | Status `0x1` |
| 12 | Failure handling: settlement succeeded but the shop callback failed; the Gateway reported `reconciliation_required` and did not mark the order paid | `0x4f0acce11f4ca7efe14a8e97f927e66b689c9a8209b6edf796a6248c1976be17` | | ECnySim payment | Order left awaiting payment, by design |

Blank block numbers are to be filled in from the chain during the re-check.

## Refusals recorded in the same runs

These attempts were refused; denials are recorded by audit anchors rather than payment transactions.

| Attempt | Outcome |
|---|---|
| Payment request whose signed amount was changed | Rejected; attempt anchored |
| Payment to the registered fire-drill decoy merchant | Rejected before Guardian or rail execution |
| Request from a frozen agent | Rejected at the first check |
| Second payment of an already paid order (agent after human QR payment) | Rejected as `duplicate_payment` |
| Scanning an already paid QR again | Rejected as `scan_invalid` |
| Payment whose mandate category did not match the merchant (2026-10-20, decision `dec_8a726022da554ad0aa5fc4ebc985b716`) | Rejected at the mandate check; no payment settled; denial anchored in `0x60cbaa65332bcc192c70dbe574a0b55a1f7e64cef8b0173f4b3834c8155a4ad6`, block 563 (`0x233`), status `0x1` |
| Reuse of the denied signed payment request with a new mandate (2026-10-20) | Rejected before full checks as `payreq_invalid` (HTTP 400); not anchored, because it never reached the decision pipeline |

## How to verify a hash

With the local chain running (`./scripts/local-demo-up.sh` in the repository):

```sh
curl -s -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_getTransactionReceipt","params":["<hash>"],"id":1}' \
  http://127.0.0.1:8545
```

A valid receipt shows `status` `0x1`, the block number, and the contract's event log.
The same hash appears in the WeBank-signed receipt in the app and in the shop's order record.

## Limits

- Local permissioned chain; not publicly resolvable.
- Simulated token, mock merchants, simulated biometric approval in the web demo.
- Hashes come from the team's recorded runs on 2026-10-14 and 2026-10-15; chain state must still contain them at review time, or they must be regenerated and this file updated.
