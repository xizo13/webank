import type { FastifyInstance } from "fastify";

/** Close the listener and state writer before the launcher observes process exit. */
export function installGatewayShutdown(app: FastifyInstance): void {
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void app.close().catch(() => {
      process.stderr.write(
        "Gateway could not close its state writer cleanly\n",
      );
      process.exitCode = 1;
    });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
