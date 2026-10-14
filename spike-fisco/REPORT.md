# FISCO BCOS spike report

Executed on 2026-10-14 on macOS arm64.

## Verdict

**GO: use FISCO BCOS as the main demo chain through the TypeScript Gateway.**
The four-node non-SM Air chain ran locally on FISCO BCOS v3.17.1.
Viem 2.57.5 deployed both Solidity 0.8.11 contracts, submitted transactions, read receipts and events, and detected both spending-rule failures.
No Java or other language bridge is needed for the tested flow.
The Gateway needs a small FISCO-specific error decoder because FISCO returns revert data with RPC error code `16`, which viem does not automatically turn into `ContractFunctionRevertedError`.
The chain is permissioned and local, so a judge cannot resolve its hashes in a public explorer.
This verdict covers a local non-SM prototype, not production banking deployment or actual e-CNY settlement.

## Versions and provenance

| Component | Version or evidence |
|---|---|
| Host | macOS arm64, Node v22.15.0, npm 10.9.2 |
| FISCO BCOS | Official `v3.17.1` macOS arm archive from `github.com/FISCO-BCOS/FISCO-BCOS/releases/download/v3.17.1/fisco-bcos-macOS-arm.tar.gz` |
| Binary | `FISCO BCOS Version : 3.17.1`, build commit `b29d0cbe161e2cb743aba89967c71fc4160dc9bb` |
| Archive SHA-256 | `9c7a7524b43f2f2354b0aacd32b921caeafc3472837d16b3bccd164a5bd1a4f4` |
| Binary SHA-256 | `61ca196b30872d1d0070381b05fedb718ac038303690bb319b8f15aaa7223495` |
| Chain | Air, four nodes, PBFT, non-SM, group `group0`, Web3 chain ID `20200` |
| RPC | Web3 JSON-RPC on `127.0.0.1:8545`, enabled only on node0 |
| Solidity | `solc@0.8.11`, EVM target `london` |
| TypeScript | `viem@2.57.5`, `typescript@5.9.3`, `tsx@4.23.15` |

The official tagged Air builder was downloaded from `raw.githubusercontent.com/FISCO-BCOS/FISCO-BCOS/v3.17.1/tools/BcosAirBuilder/build_chain.sh`.
The builder obtained its TASSL helper from the official FISCO-BCOS/TASSL release.
All retained downloaded binaries, generated nodes, keys, npm cache, and test output are under ignored `vendor/`, except the ignored `.env` test signer in this directory.
The builder initially wrote TASSL to `~/.fisco`; I moved that helper to `vendor/home/.fisco` and removed the now-empty external directory.

## Success criteria

| # | Result | Executed evidence |
|---|---|---|
| 1. Local Air chain | **Yes** | Official builder completed with `Server IP 127.0.0.1:4`, `SM model false`; `start_all.sh` reported node0 through node3 running; `eth_chainId` returned `0x4ee8` (20200); `eth_blockNumber` returned `0xd` after the final run. |
| 2. Compile and deploy Solidity 0.8.x | **Yes** | `solc 0.8.11+commit.d7f03943` compiled both supplied contracts with EVM `london`; viem deployment receipts succeeded and returned contract addresses. |
| 3. TypeScript transaction, result, event, hash | **Yes** | viem submitted `anchor`, `pay(27900)`, and `freeze`; receipts were successful; `parseEventLogs` decoded one `Anchored` and one `Paid` event; all five successful transactions printed hashes. |
| 4. Ethereum JSON-RPC and viem | **Yes, with an adapter** | `eth_chainId`, `eth_call`, `eth_getTransactionReceipt`, and raw transaction submission worked through viem HTTP; see the revert and log-format caveats below. |
| 5. Detect a `require` revert in TypeScript | **Yes** | An over-cap `eth_call` returned revert bytes for `Error("over cap")`; after `freeze`, another returned `Error("frozen")`; the runner decoded and asserted both reasons. |
| 6. Explorer and SM mode | **Partial** | The local Web3 RPC can retrieve a receipt by hash for a judge-facing recording; no WeBASE/explorer was installed, and SM mode was intentionally not tested. |

The failure checks used `simulateContract`, which executes `eth_call` without submitting a failed transaction.
They prove that the contract cap and freeze conditions reject those calls and that TypeScript can identify the reasons.
They do not produce failed on-chain receipts or denial audit anchors.

## Final run evidence

The complete final stdout is retained in ignored `vendor/run-output.txt` on this machine.
The generated signer private key was never printed.

```text
$ npm install --no-audit --no-fund --cache vendor/npm-cache
added 45 packages in 16s
$ npm run typecheck
> tsc --noEmit
<exit 0>
$ curl -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' http://127.0.0.1:8545
{"id":1,"jsonrpc":"2.0","result":"0x4ee8"}
$ npm run spike
{"rpcUrl":"http://127.0.0.1:8545","chainId":20200,"account":"0xE74cCe3B200363d9e911ff958095508e5ab5F9D8","solc":"0.8.11+commit.d7f03943.Emscripten.clang"}
deploy AuditAnchor: tx=0x16c3460662f2056e15de959e95ee885325f49dd79bb3027f1c6ffadb13ec76cd latency_ms=6252
AuditAnchor: address=0x441A893DF9B5b5577EA4059010eBD652113A45B7
deploy CappedWallet: tx=0x7b6ab9d992e6da961deba19ca8632b0eb9c5eccae62634864efdd0a1deed94af latency_ms=226
CappedWallet: address=0xA47C9aE81002aD82A5e7Fb67cc45D50C8c3b385B
anchor: tx=0xbddefaae69c2f3219aecc0db4f40b173a0683ae64a3212f45e332bd7815e09ba latency_ms=627
Anchored: recordHash=0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8 kind=1 transactionHash=0xbddefaae69c2f3219aecc0db4f40b173a0683ae64a3212f45e332bd7815e09ba
pay 27900: tx=0xfa619ef048d2cfff72bcdfc24b93064fdae5e80a523eb3c0e94f5f702a4fdf67 latency_ms=623
Paid: orderId=0x6585f3e784d6e5a0194fdcf09a670f505cd46524c4da671657a7d0b3121e83b6 amount=27900 transactionHash=0xfa619ef048d2cfff72bcdfc24b93064fdae5e80a523eb3c0e94f5f702a4fdf67
pay 50000: revert=over cap latency_ms=3
freeze: tx=0x6a47f37ad72e071132506804ad1b38317f9b58445cd2ec2474702b16deef9a93 latency_ms=211
pay 100: revert=frozen latency_ms=3
```

The raw `eth_getTransactionReceipt` response for the `pay(27900)` hash had `status: "0x1"`, `blockNumber: "0xc"`, the `Paid` topic, and `gasUsed: "0xdba2"`.
The command is reproducible with `curl` or viem `getTransactionReceipt` while the local nodes are running.

## Reproduce from a clean directory

Run these commands from `spike-fisco/` on macOS arm64 with GitHub and npm access.
The official `v3.17.1` archive exists, so no v3.16.4 fallback was needed.
The builder writes a TASSL helper under `$HOME/.fisco`, so the command temporarily sets `HOME` to `vendor/home` to retain all downloaded artifacts inside this spike directory.

```sh
mkdir -p vendor
curl -fL --retry 2 -o vendor/fisco-bcos-v3.17.1-macOS-arm.tar.gz https://github.com/FISCO-BCOS/FISCO-BCOS/releases/download/v3.17.1/fisco-bcos-macOS-arm.tar.gz
tar -tzf vendor/fisco-bcos-v3.17.1-macOS-arm.tar.gz >/dev/null
tar -xzf vendor/fisco-bcos-v3.17.1-macOS-arm.tar.gz -C vendor
curl -fL -o vendor/build_chain.sh https://raw.githubusercontent.com/FISCO-BCOS/FISCO-BCOS/v3.17.1/tools/BcosAirBuilder/build_chain.sh
HOME="$PWD/vendor/home" bash vendor/build_chain.sh -v v3.17.1 -p 30300,20200 -l 127.0.0.1:4 -o vendor/nodes -e vendor/fisco-bcos
npm install --no-audit --no-fund --cache vendor/npm-cache
npm run typecheck
```

Set `[web3_rpc]` in `vendor/nodes/127.0.0.1/node0/config.ini` to `enable=true`, `listen_ip=127.0.0.1`, and `listen_port=8545` before starting nodes.
The generated `config.genesis` already contains `[web3] chain_id=20200` and `sm_crypto=false`.
Leave Web3 RPC disabled on nodes 1 through 3 so they do not compete for port 8545.
The official builder's P2P and native RPC listeners default to `0.0.0.0`; limit those separately if the local machine's network exposure matters.

```sh
bash vendor/nodes/127.0.0.1/start_all.sh
curl -sS -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' http://127.0.0.1:8545
node --input-type=module -e "import { generatePrivateKey } from 'viem/accounts'; import { writeFileSync } from 'node:fs'; writeFileSync('.env', 'FISCO_PRIVATE_KEY=' + generatePrivateKey() + '\\n', { mode: 0o600 });"
set -a
. ./.env
set +a
npm run spike
bash vendor/nodes/127.0.0.1/stop_all.sh
```

`.env`, `vendor/`, and `node_modules/` are ignored by `.gitignore`.
The test key does not require funding in this default local Air configuration; the successful transactions returned `effectiveGasPrice: "0x0"`.
The four nodes were stopped after the final evidence check.

## Gateway integration

Use viem directly with `http('http://127.0.0.1:8545')`, a chain definition with ID `20200`, and a signer kept in the Gateway's key boundary.
Read contract addresses from deployment receipts.
Use `scripts/run.ts` as the tested transaction and event example.
For revert reasons, the tested FISCO-specific fallback is:

```ts
const rpcError = error instanceof BaseError
  ? error.walk((cause) => cause !== null && typeof cause === 'object'
      && 'data' in cause && typeof cause.data === 'string'
      && cause.data.startsWith('0x'))
  : undefined;
const reason = rpcError && 'data' in rpcError && typeof rpcError.data === 'string'
  ? decodeErrorResult({ abi: cappedWalletAbi, data: rpcError.data as Hex }).args?.[0]
  : undefined;
```

This fallback was exercised for both `over cap` and `frozen` on FISCO v3.17.1.
Keep the usual viem `ContractFunctionRevertedError` path as well for compatibility with other chains.

## Pain points and judge evidence

- FISCO's failed `eth_call` returned `{"error":{"code":16,"data":"0x08c379a0...","message":""}}`.
  The revert payload is standard Solidity `Error(string)`, but the RPC code and empty message prevented automatic viem decoding.
- The raw `Paid` receipt returned a valid top-level `transactionIndex: "0x0"` but a malformed log-level `transactionIndex: "0x307830"`.
  Viem consequently displayed the parsed event's log-level transaction index as `3176496`.
  Do not rely on that log field until it is normalized or fixed upstream; event names, arguments, topics, block number, and transaction hash worked.
- The `Anchored` event's `at` argument used a millisecond-scale FISCO block timestamp (`1791945431182`), despite Ethereum consumers often expecting seconds.
  Normalize timestamps at the adapter boundary.
- The first npm install failed because the machine's shared `~/.npm` cache had an `EACCES`/`EEXIST` rename conflict.
  Repeating with `--cache vendor/npm-cache` succeeded without changing global permissions.
- The node processes did not outlive an isolated command session in this agent environment.
  Start the nodes and run the spike in the same terminal session or use a persistent local shell.
- A FISCO transaction hash is only visible to someone with access to this local permissioned chain.
  For judges, keep the nodes running during the demo and show a read-only receipt lookup over the Web3 RPC, or include a console capture and the matching signed receipt in the submission.
  WeBASE was not installed during this scoped spike, so no explorer link or screenshot is claimed.
- Non-SM execution is proven here; SM2/SM3 compatibility and production key custody remain separate work.

Official sources: [FISCO BCOS release](https://github.com/FISCO-BCOS/FISCO-BCOS/releases/tag/v3.17.1), [Air chain builder](https://github.com/FISCO-BCOS/FISCO-BCOS/blob/v3.17.1/tools/BcosAirBuilder/build_chain.sh), [Web3 RPC guide](https://fisco-bcos-doc.readthedocs.io/zh-cn/latest/docs/develop/web3_usage.html), and [Solidity guidance](https://fisco-bcos-doc.readthedocs.io/zh-cn/latest/docs/contract_develop/solidity_develop.html).
