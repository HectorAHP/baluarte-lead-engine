#!/usr/bin/env node
// Fase 2.2.12A -- minimal, standalone script for Render Cron to call
// POST /internal/hubspot-sync/run. Deliberately plain JavaScript (no TypeScript, no build step,
// no imports from src/ or node_modules) so `node scripts/hubspot-outbox-drain.mjs` works with
// zero setup beyond a bare Node runtime -- uses only Node 22's built-in fetch/AbortController.
//
// Replaces the earlier Docker-Command approach (Fase 2.2.12), which failed with exit 127 (the
// command was misinterpreted by the container's shell) and, separately, leaked the rotated
// secret into Render's logs. This script exists specifically to make both failure modes
// impossible: it is a single, testable file (no shell-quoting ambiguity), and it NEVER prints
// the secret -- only the Authorization header's VALUE ever holds it, which curl/fetch itself
// never echoes back anywhere this script could log it.
//
// Required environment variables:
//   LEAD_ENGINE_BASE_URL        e.g. https://baluarte-lead-engine.onrender.com
//   HUBSPOT_SYNC_RUNNER_SECRET  the same Bearer token the Web Service validates
// Optional:
//   HUBSPOT_SYNC_TIMEOUT_MS     overrides the default request timeout (15000ms) -- exists purely
//                                so this exact file can be exercised in tests without a slow
//                                real-timeout wait; production never needs to set it.
//
// Exit code is the ONLY signal Render's Cron Job run-history needs: 0 = success (HTTP 2xx from
// the runner), non-zero = failure (missing env, network error, timeout, or a non-2xx response).

const DEFAULT_TIMEOUT_MS = 15_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  const baseUrl = process.env.LEAD_ENGINE_BASE_URL;
  const secret = process.env.HUBSPOT_SYNC_RUNNER_SECRET;

  if (!baseUrl) return fail("ERROR: LEAD_ENGINE_BASE_URL is not set");
  if (!secret) return fail("ERROR: HUBSPOT_SYNC_RUNNER_SECRET is not set");

  const timeoutMs = Number(process.env.HUBSPOT_SYNC_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const url = `${baseUrl.replace(/\/+$/, "")}/internal/hubspot-sync/run`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      // The secret is used HERE ONLY, as the header's value -- never assigned to a variable
      // that is later logged, never interpolated into any console.log/console.error call below.
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err && err.name === "AbortError" ? "request timed out" : "network error";
    return fail(`ERROR: hubspot-sync/run request failed (${reason})`);
  } finally {
    clearTimeout(timeoutId);
  }

  // The runner's own response body is already sanitized server-side (app.ts: "counts only --
  // never a leadId/submissionId/email/phone/HubSpot response body") -- safe to print in full.
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  console.log(`${new Date().toISOString()} HTTP status: ${response.status}`);
  if (bodyText) console.log(bodyText);

  if (response.status < 200 || response.status >= 300) {
    return fail(`ERROR: hubspot-sync/run returned HTTP ${response.status}`);
  }

  process.exit(0);
}

main().catch(() => {
  console.error("ERROR: unexpected failure in hubspot-outbox-drain.mjs");
  process.exit(1);
});
