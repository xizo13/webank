import Fastify from "fastify";
import { DurableState } from "../../src/durable-state.js";
import { installGatewayShutdown } from "../../src/shutdown.js";

const path = process.env.WEBANK_TEST_STATE_PATH;
if (!path) throw new Error("Missing test state path");
const state = new DurableState<{ ready: boolean }>(path);
state.save({ ready: true });
const app = Fastify();
app.addHook("onClose", async () => state.close());
await app.listen({ host: "127.0.0.1", port: 0 });
installGatewayShutdown(app);
process.stdout.write("READY\n");
