import { timingSafeEqualStrings } from "./timing-safe-compare.js";

export type AdminAuthResult = "OK" | "NOT_CONFIGURED" | "UNAUTHORIZED";

/**
 * Fase 7E.2 -- the admin-token authorization decision, extracted into its own pure, directly
 * unit-testable function. Previously this logic lived ONLY inline inside app.ts's
 * `requireAdminToken` Fastify closure, which made its exact behavior on an unexpected input
 * impossible to exercise in isolation -- see the Fase 7E.2 report for the full diagnostic that
 * led here (a real production 500/INTERNAL_ERROR was reported for a request with no
 * `x-admin-token` header; it could NOT be reproduced locally under any scenario tried -- in-
 * process, real TCP+HTTP, tsx-transpiled, tsc-compiled -- but this function closes the one
 * structural gap that audit found: nothing previously guaranteed this decision itself could never
 * throw).
 *
 * Used by EVERY ADMIN_API_TOKEN-protected route (mark-completed, mark-no-show, recover-handoff)
 * via the SAME shared call site in app.ts -- never duplicated per route, so all three routes'
 * auth behavior can never drift apart.
 *
 * NEVER throws, by construction: `providedToken` is deliberately typed `unknown` (a header value
 * off `req.headers` is not guaranteed to be a plain string even after the array-vs-string
 * unwrapping app.ts does before calling this) and coerced defensively; ANY unexpected failure
 * while comparing the two values is treated exactly like a wrong token -- UNAUTHORIZED, never
 * propagated as an exception that could reach app.setErrorHandler's generic 500 catch-all. An
 * admin-auth boundary must never leak an internal error state to an unauthenticated caller (Fase
 * 7E.2 spec §6/§7: "no exponer detalles de seguridad", "no permitir fallback" -- failing closed to
 * UNAUTHORIZED is the fail-closed outcome, never a bypass to OK).
 */
export function checkAdminToken(providedToken: unknown, configuredToken: string | undefined): AdminAuthResult {
  if (!configuredToken) return "NOT_CONFIGURED";
  try {
    const provided = typeof providedToken === "string" ? providedToken : "";
    return timingSafeEqualStrings(provided, configuredToken) ? "OK" : "UNAUTHORIZED";
  } catch {
    return "UNAUTHORIZED";
  }
}
