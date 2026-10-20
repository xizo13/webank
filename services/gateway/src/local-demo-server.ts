import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type ChainAddresses, connectFisco } from "@webank/chain";
import { createLocalDemoGateway } from "./local-demo.js";
import {
  requiredLoginTokenPath,
  writePrivateLoginToken,
} from "./private-login-token.js";
import { installGatewayShutdown } from "./shutdown.js";

if (
  process.env.NODE_ENV === "production" ||
  process.env.WEBANK_LOCAL_DEMO !== "1" ||
  process.env.WEBANK_DEMO_APPROVALS !== "1"
)
  throw new Error("Loopback demo flags are required outside production");
const host = "127.0.0.1";
const port = Number(process.env.WEBANK_LOCAL_DEMO_PORT ?? "3002");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid local demo port");
const tokenFile = requiredLoginTokenPath("WEBANK_LOCAL_DEMO_TOKEN_FILE");
const rpcUrl = process.env.FISCO_RPC_URL ?? "http://127.0.0.1:8545";
const rpc = new URL(rpcUrl);
if (
  rpc.protocol !== "http:" ||
  rpc.hostname !== host ||
  rpc.pathname !== "/" ||
  rpc.search ||
  rpc.hash ||
  rpc.username ||
  rpc.password
)
  throw new Error("FISCO RPC must use 127.0.0.1 HTTP in local demo mode");
const privateKey = process.env.FISCO_GATEWAY_PRIVATE_KEY;
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey))
  throw new Error("FISCO_GATEWAY_PRIVATE_KEY is required");
const shopToken = process.env.SHOP_INTERNAL_TOKEN;
if (!shopToken) throw new Error("SHOP_INTERNAL_TOKEN is required");
if (
  existsSync(
    new URL(
      "../../../scripts/local-demo-runtime/funding-cutover.json",
      import.meta.url,
    ),
  )
)
  throw new Error(
    "Funding cutover is incomplete; resume migration before starting Gateway",
  );
const addresses = JSON.parse(
  await readFile(
    new URL("../../../scripts/chain/addresses.json", import.meta.url),
    "utf8",
  ),
) as ChainAddresses;
const manifest = JSON.parse(
  await readFile(
    new URL("../../../scripts/chain/merchants.json", import.meta.url),
    "utf8",
  ),
) as { merchants: Parameters<typeof createLocalDemoGateway>[0]["merchants"] };
const chain = await connectFisco({
  rpcUrl,
  privateKey: privateKey as `0x${string}`,
});
const { app, loginToken } = await createLocalDemoGateway({
  chain,
  addresses,
  merchants: manifest.merchants,
  shopOrigin: process.env.WEBANK_SHOP_URL ?? "http://127.0.0.1:3001",
  appOrigin: process.env.WEBANK_DEMO_APP_ORIGIN ?? "http://127.0.0.1:8081",
  gatewayOrigin: `http://${host}:${port}`,
  shopToken,
  statePath:
    process.env.WEBANK_GATEWAY_STATE_PATH ??
    fileURLToPath(
      new URL(
        "../../../scripts/local-demo-runtime/gateway-state.json",
        import.meta.url,
      ),
    ),
});
await writePrivateLoginToken(tokenFile, loginToken);
await app.listen({ host, port });
installGatewayShutdown(app);
process.stdout.write(`SIMULATED local Gateway at http://${host}:${port}\n`);
process.stdout.write("Private local app token file created.\n");
process.stdout.write(
  "Approval proof is simulated. FISCO transactions use local test tokens only.\n",
);
