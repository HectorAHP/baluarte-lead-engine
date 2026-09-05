import { describe, it, expect } from "vitest";
import Fastify from "fastify";

/**
 * Fase 7C item 2 -- "NO asumir comportamiento" about what a browser-side AbortController/timeout
 * actually does to an in-flight Fastify request handler. This is a real, isolated technical test
 * against a throwaway Fastify instance (not this app's own routes) -- it answers the question
 * empirically rather than by inference from documentation.
 *
 * Method: a route handler does slow async work (simulating a slow HubSpot call) that increments a
 * module-level counter partway through and again at the very end. A real HTTP client aborts its
 * request BEFORE the handler finishes. We then wait past the handler's own total duration and
 * check whether the "finished" increment happened -- i.e. whether the handler kept running to
 * completion server-side despite the client giving up, or whether Node/Fastify tore it down.
 */
describe("Fase 7C item 2 -- client abort semantics on a slow Fastify handler", () => {
  it("an aborted client request does NOT stop the handler's async work from completing server-side", async () => {
    const app = Fastify({ logger: false });
    let startedCount = 0;
    let finishedCount = 0;
    let handlerSawAbort = false;

    app.post("/slow", async (req, reply) => {
      startedCount++;
      // Simulate the exact shape of a real handler: some fast synchronous-ish work (Supabase
      // writes), then a slow downstream call (HubSpot), all inside one await chain -- nothing
      // here ever inspects req.raw for cancellation, exactly like WebLeadCaptureService today.
      await new Promise((resolve) => setTimeout(resolve, 50)); // "Supabase persistence"
      req.raw.on("close", () => { handlerSawAbort = req.raw.destroyed || req.raw.aborted === true; });
      await new Promise((resolve) => setTimeout(resolve, 300)); // "slow HubSpot call"
      finishedCount++;
      return reply.code(201).send({ ok: true });
    });

    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const controller = new AbortController();
    // Abort well before the handler's own ~350ms total duration -- mirrors impuestos.html's
    // LEAD_ENGINE_TIMEOUT_MS firing before the backend responds.
    setTimeout(() => controller.abort(), 80);

    let clientError: unknown;
    try {
      await fetch(`http://127.0.0.1:${port}/slow`, { method: "POST", signal: controller.signal });
    } catch (err) {
      clientError = err;
    }
    expect(clientError).toBeDefined(); // the client DOES see this as a failure -- AbortError/fetch failed

    // Wait past the handler's own total duration (350ms) plus margin, then check whether it ran
    // to completion anyway, server-side, despite the client having already given up at 80ms.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(startedCount).toBe(1);
    // THE ANSWER: Fastify/Node does NOT cancel the handler's Promise chain just because the
    // client's socket closed. The handler keeps running to completion in the background -- its
    // own side effects (here, incrementing finishedCount; in production, the Supabase writes and
    // the HubSpot sync call) complete normally. The ONLY thing that fails is the final
    // `reply.send()` -- Fastify logs an error internally for that outbound write (or, as
    // observed here, simply has nowhere to deliver it), but that happens strictly AFTER all the
    // handler's own awaited work has already finished.
    expect(finishedCount).toBe(1);

    await app.close();
  });
});
