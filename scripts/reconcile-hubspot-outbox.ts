/**
 * Fase 7C -- CLI for HubSpotOutboxReconciliationService (see
 * src/application/hubspot-outbox-reconciliation.ts for the full design and the documented
 * limitation on what can/cannot be safely reconciled).
 *
 * Usage:
 *   npm.cmd run reconcile:hubspot-outbox -- --since 2026-01-01                (dry run, default)
 *   npm.cmd run reconcile:hubspot-outbox -- --since 2026-01-01 --execute      (applies FAILED_PERMANENT_RETRIABLE resets only)
 *
 * --since is REQUIRED (no implicit "since the beginning of time" default -- forces the operator
 * to make a conscious choice about scan size). --limit defaults to 500. --execute is NEVER the
 * default; omitting it always produces a read-only report. This script has never been run against
 * this project's real Supabase/HubSpot in this session -- see the Fase 7C report's explicit
 * confirmation.
 *
 * Never prints PII: candidates are always rendered through formatCandidateForDisplay
 * (leadIdLast8/submissionIdLast8 only).
 */
import { config } from "../src/config.js";
import { createSupabaseClient } from "../src/infrastructure/supabase-client.js";
import { SupabaseFiscalLeadScoreRepository } from "../src/infrastructure/supabase-fiscal-lead-score-repository.js";
import { SupabaseHubSpotSyncOutboxRepository } from "../src/infrastructure/supabase-hubspot-sync-outbox-repository.js";
import { HubSpotOutboxReconciliationService, formatCandidateForDisplay } from "../src/application/hubspot-outbox-reconciliation.js";

export class ReconcileHubSpotOutboxUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconcileHubSpotOutboxUsageError";
  }
}

export interface ReconcileHubSpotOutboxArgs {
  since: Date;
  limit: number;
  execute: boolean;
}

export function parseArgs(argv: string[]): ReconcileHubSpotOutboxArgs {
  let since: Date | undefined;
  let limit = 500;
  let execute = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--since") {
      const raw = argv[++i];
      const parsed = raw ? new Date(raw) : undefined;
      if (!raw || !parsed || Number.isNaN(parsed.getTime())) throw new ReconcileHubSpotOutboxUsageError("--since requires a valid ISO date, e.g. --since 2026-01-01");
      since = parsed;
    } else if (arg === "--limit") {
      const raw = argv[++i];
      const parsed = raw ? Number(raw) : NaN;
      if (!Number.isInteger(parsed) || parsed <= 0) throw new ReconcileHubSpotOutboxUsageError("--limit requires a positive integer");
      limit = parsed;
    } else if (arg === "--execute") {
      execute = true;
    } else {
      throw new ReconcileHubSpotOutboxUsageError(`Unrecognized argument: ${arg}`);
    }
  }
  if (!since) throw new ReconcileHubSpotOutboxUsageError("--since <ISO date> is required (e.g. --since 2026-01-01) -- no implicit scan-everything default");
  return { since, limit, execute };
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY) {
    console.error("SUPABASE_URL / SUPABASE_SECRET_KEY are not configured -- refusing to run against no real database.");
    process.exitCode = 1;
    return;
  }

  const client = createSupabaseClient();
  const fiscalLeadScores = new SupabaseFiscalLeadScoreRepository(client);
  const outbox = new SupabaseHubSpotSyncOutboxRepository(client);
  const logger = { warn: (details: Record<string, unknown>, message: string) => console.error(JSON.stringify({ level: "warn", message, ...details })) };
  const service = new HubSpotOutboxReconciliationService(fiscalLeadScores, outbox, logger);

  const report = await service.dryRun(args.since, args.limit);
  console.log(JSON.stringify({
    scannedFiscalScores: report.scannedFiscalScores,
    candidateCount: report.candidateCount,
    candidates: report.candidates.map(formatCandidateForDisplay),
  }, null, 2));

  if (!args.execute) {
    console.log("\nDry-run only -- no changes made. Pass --execute to reset FAILED_PERMANENT_RETRIABLE candidates (only) to PENDING for the next worker run.");
    return;
  }

  const retriable = report.candidates.filter((c) => c.reason === "FAILED_PERMANENT_RETRIABLE");
  console.log(`\n--execute passed: resetting ${retriable.length} FAILED_PERMANENT_RETRIABLE candidate(s). MISSING_OUTBOX_PARTIAL_DATA_ONLY candidates are NEVER auto-executed -- see the report for those, review manually.`);
  const result = await service.execute(report.candidates, new Date());
  console.log(JSON.stringify(result, null, 2));
}
