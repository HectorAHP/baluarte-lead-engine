import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp();
// 0.0.0.0 (not "localhost"/127.0.0.1) so the process accepts connections from outside its own
// container/VM -- required by every real hosting platform (Railway, Render, Fly, etc.), which all
// proxy external traffic in on a routable interface, not loopback. config.PORT already reads
// process.env.PORT (see config.ts), which is how those platforms tell the process which port to
// bind -- never hardcoded here.
await app.listen({ port: config.PORT, host: "0.0.0.0" });

// Production hardening: graceful shutdown. Every mainstream Node host (Railway, Render, Fly,
// Docker, Kubernetes) sends SIGTERM before killing a process on deploy/restart/scale-down -- an
// in-flight POST /api/leads (or any other request) must be allowed to finish, and Fastify's own
// listeners closed cleanly, rather than the connection being dropped mid-request. app.close()
// does exactly this: stops accepting new connections and waits for in-flight ones to complete.
async function shutdown(signal: string) {
  app.log.info({ signal }, "received shutdown signal, closing gracefully");
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, "error during graceful shutdown");
    process.exit(1);
  }
}
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });
