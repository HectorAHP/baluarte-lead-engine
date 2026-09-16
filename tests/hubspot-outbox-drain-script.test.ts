import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";

/**
 * Fase 2.2.12A -- tests the REAL standalone script as a subprocess (never imports its internals),
 * exactly how Render's Cron Job actually invokes it: `node scripts/hubspot-outbox-drain.mjs` with
 * environment variables. This is the only way to genuinely verify two of the five required
 * properties: the process's real exit code, and that the secret literally never appears in
 * anything the process printed (stdout or stderr) -- a unit test against extracted logic could
 * never catch a `console.log(secret)` left in by accident.
 */

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/hubspot-outbox-drain.mjs", import.meta.url));
const TEST_SECRET = "test-secret-must-never-appear-in-logs-abc123";

let servers: Server[] = [];

afterEach(async () => {
  for (const s of servers) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  servers = [];
});

/** Starts a throwaway HTTP server on an ephemeral port that responds however the test needs, and
 * records the Authorization header it received (for the assertion that the script sends it
 * correctly, without ever needing the SCRIPT to log it). */
function startFakeLeadEngine(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      servers.push(s);
      resolve({ url: `http://127.0.0.1:${port}`, server: s });
    });
  });
}

function runScript(env: Record<string, string | undefined>): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: { ...process.env, ...env },
      // Never inherit the parent's PATH-based node_modules resolution assumptions -- this script
      // must run standalone, exactly as Render's Cron Job would run it.
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

describe("Fase 2.2.12A -- scripts/hubspot-outbox-drain.mjs (real subprocess)", () => {
  it("TEST 1: HTTP 200 from the runner -> exit 0", async () => {
    let receivedAuth: string | undefined;
    const { url } = await startFakeLeadEngine((req, res) => {
      receivedAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, claimed: 1, succeeded: 1, retryScheduled: 0, permanentlyFailed: 0 }));
    });

    const { exitCode, stdout, stderr } = await runScript({
      LEAD_ENGINE_BASE_URL: url,
      HUBSPOT_SYNC_RUNNER_SECRET: TEST_SECRET,
    });

    expect(exitCode).toBe(0);
    expect(receivedAuth).toBe(`Bearer ${TEST_SECRET}`);
    expect(stdout).toContain("HTTP status: 200");
    expect(stdout).toContain('"succeeded":1');
    expect(stdout + stderr).not.toContain(TEST_SECRET);
  });

  it("TEST 2a: HTTP 401 from the runner -> exit != 0", async () => {
    const { url } = await startFakeLeadEngine((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
    });

    const { exitCode, stdout, stderr } = await runScript({
      LEAD_ENGINE_BASE_URL: url,
      HUBSPOT_SYNC_RUNNER_SECRET: TEST_SECRET,
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("HTTP 401");
    expect(stdout + stderr).not.toContain(TEST_SECRET);
  });

  it("TEST 2b: HTTP 500 from the runner -> exit != 0", async () => {
    const { url } = await startFakeLeadEngine((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error" }));
    });

    const { exitCode, stderr } = await runScript({
      LEAD_ENGINE_BASE_URL: url,
      HUBSPOT_SYNC_RUNNER_SECRET: TEST_SECRET,
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("HTTP 500");
  });

  it("TEST 3a: missing LEAD_ENGINE_BASE_URL -> exit != 0, never attempts a request", async () => {
    let called = false;
    await startFakeLeadEngine((_req, res) => { called = true; res.writeHead(200); res.end("{}"); });

    const { exitCode, stderr } = await runScript({
      LEAD_ENGINE_BASE_URL: undefined,
      HUBSPOT_SYNC_RUNNER_SECRET: TEST_SECRET,
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("LEAD_ENGINE_BASE_URL is not set");
    expect(called).toBe(false);
  });

  it("TEST 3b: missing HUBSPOT_SYNC_RUNNER_SECRET -> exit != 0, never attempts a request", async () => {
    let called = false;
    const { url } = await startFakeLeadEngine((_req, res) => { called = true; res.writeHead(200); res.end("{}"); });

    const { exitCode, stderr } = await runScript({
      LEAD_ENGINE_BASE_URL: url,
      HUBSPOT_SYNC_RUNNER_SECRET: undefined,
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("HUBSPOT_SYNC_RUNNER_SECRET is not set");
    expect(called).toBe(false);
  });

  it("TEST 4: the secret never appears in stdout or stderr, across success AND failure", async () => {
    const { url } = await startFakeLeadEngine((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
    });

    const { stdout, stderr } = await runScript({
      LEAD_ENGINE_BASE_URL: url,
      HUBSPOT_SYNC_RUNNER_SECRET: TEST_SECRET,
    });

    expect(stdout).not.toContain(TEST_SECRET);
    expect(stderr).not.toContain(TEST_SECRET);
    expect(stdout + stderr).not.toMatch(/Bearer /); // the header value is never echoed, not even redacted-looking
  });

  it("TEST 5a: request timeout -> exit != 0", async () => {
    const { url } = await startFakeLeadEngine((_req, _res) => {
      // Never responds -- simulates a hung/unreachable Lead Engine.
    });

    const { exitCode, stderr } = await runScript({
      LEAD_ENGINE_BASE_URL: url,
      HUBSPOT_SYNC_RUNNER_SECRET: TEST_SECRET,
      HUBSPOT_SYNC_TIMEOUT_MS: "200", // short, test-only override -- production never sets this
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("timed out");
  });

  it("TEST 5b: network error (connection refused) -> exit != 0", async () => {
    // Port 1 is a reserved/unlikely-to-be-listening port -- guarantees ECONNREFUSED without
    // depending on any real network access.
    const { exitCode, stderr } = await runScript({
      LEAD_ENGINE_BASE_URL: "http://127.0.0.1:1",
      HUBSPOT_SYNC_RUNNER_SECRET: TEST_SECRET,
      HUBSPOT_SYNC_TIMEOUT_MS: "2000",
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("network error");
  });

  it("trailing slash in LEAD_ENGINE_BASE_URL is handled -- never a double slash in the URL", async () => {
    let receivedPath: string | undefined;
    const { url } = await startFakeLeadEngine((req, res) => {
      receivedPath = req.url;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, claimed: 0, succeeded: 0, retryScheduled: 0, permanentlyFailed: 0 }));
    });

    const { exitCode } = await runScript({
      LEAD_ENGINE_BASE_URL: `${url}/`,
      HUBSPOT_SYNC_RUNNER_SECRET: TEST_SECRET,
    });

    expect(exitCode).toBe(0);
    expect(receivedPath).toBe("/internal/hubspot-sync/run");
  });
});
