/**
 * Fase 7H / 7H.1 -- repair tool for appointments left orphaned in status=BOOKED after their
 * endsAt has already passed (the root cause behind lead eb95060d's cancellation/reschedule
 * incident: two simultaneous "active" BOOKED rows made WhatsAppCancellationHandler/
 * WhatsAppRescheduleHandler's findTargetAppointment see ">1 active" and escalate every attempt to
 * HUMAN_HANDOFF).
 *
 * AppointmentService.expirePriorStaleBookedAppointments (see src/application/services.ts) already
 * prevents this going forward -- it runs automatically before every NEW appointment is created.
 * This script is the one-time backstop for appointments that became orphaned BEFORE that fix
 * existed and will never get a "new booking" to trigger the automatic cleanup on their own.
 *
 * Fase 7H.1 -- TARGETED, FAIL-CLOSED EXECUTION ONLY. A mass repair across every SAFE_TO_EXPIRE row
 * in the database is no longer possible in --apply mode: an explicit --lead-id or
 * --appointment-id is REQUIRED. This exists because we only ever have real authorization for one
 * concrete case at a time (e.g. lead eb95060d / appointment d34cf079) -- the tool must never be
 * able to act beyond that scope, even by a plain re-run with no arguments.
 *
 * SAFE BY DESIGN:
 *  - --dry-run is the DEFAULT (with or without --lead-id/--appointment-id). Nothing is ever
 *    written unless --apply is passed explicitly.
 *  - --apply REQUIRES --lead-id or --appointment-id. --apply with neither is REJECTED before any
 *    read or write happens.
 *  - --appointment-id scope can only ever touch that ONE row, never any other SAFE_TO_EXPIRE row
 *    that happens to exist elsewhere. --lead-id scope can only ever touch rows belonging to that
 *    lead.
 *  - Every candidate is re-classified from a FRESH read immediately before writing (not the
 *    classification from the initial read) -- if it no longer qualifies (status changed,
 *    became future, lost its unambiguous replacement), it is skipped, never forced.
 *  - The actual write is the same compare-and-set AppointmentRepository.claimTransition uses
 *    (`WHERE id=X AND status='BOOKED'`) -- a row that changed under us between the fresh
 *    reclassification and the write is still safely skipped, never overwritten.
 *  - Never infers attendance: every write is BOOKED -> EXPIRED (see AppointmentStatus's own doc
 *    comment for why this is NOT COMPLETED/NO_SHOW/CANCELLED).
 *  - Never touches Calendar. Never touches leads. Never touches a future/current appointment.
 *  - Every --apply write gets its own appointment_status_history row, eventType
 *    APPOINTMENT_EXPIRED_MANUAL_REPAIR -- deliberately DIFFERENT from the app's own automatic
 *    APPOINTMENT_EXPIRED_ON_REBOOK, so the audit trail always shows whether a given EXPIRED
 *    transition happened automatically (a real rebooking) or via this manual repair tool.
 *
 * Usage:
 *   npx tsx scripts/repair-orphaned-appointments.ts                                   # dry-run, everything (read-only)
 *   npx tsx scripts/repair-orphaned-appointments.ts --dry-run --lead-id <uuid>         # dry-run, scoped to one lead
 *   npx tsx scripts/repair-orphaned-appointments.ts --dry-run --appointment-id <uuid>  # dry-run, scoped to one appointment
 *   npx tsx scripts/repair-orphaned-appointments.ts --apply --appointment-id <uuid>    # writes ONLY that appointment, if still SAFE_TO_EXPIRE
 *   npx tsx scripts/repair-orphaned-appointments.ts --apply --lead-id <uuid>           # writes ONLY that lead's SAFE_TO_EXPIRE appointments
 *   npx tsx scripts/repair-orphaned-appointments.ts --apply                            # REJECTED -- no filter given
 *
 * Requires SUPABASE_URL and SUPABASE_SECRET_KEY in the environment (same convention as every other
 * script in this repo, e.g. scripts/bench-hubspot-capture.ts).
 */
import { pathToFileURL } from "node:url";

export interface AppointmentRow {
  id: string;
  lead_id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  calendar_event_id: string | null;
  created_at: string;
}

export type Classification = "SAFE_TO_EXPIRE" | "AMBIGUOUS" | "FUTURE" | "ALREADY_TERMINAL";

export interface ClassifiedRow {
  appointment: AppointmentRow;
  classification: Classification;
  reason: string;
}

export const EXPIRE_EVENT_TYPE = "APPOINTMENT_EXPIRED_MANUAL_REPAIR";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function classify(appointment: AppointmentRow, allForLead: AppointmentRow[], now: Date): ClassifiedRow {
  if (appointment.status !== "BOOKED") {
    return { appointment, classification: "ALREADY_TERMINAL", reason: `status is already ${appointment.status}, not BOOKED` };
  }
  const endsAt = new Date(appointment.ends_at);
  if (endsAt >= now) {
    return { appointment, classification: "FUTURE", reason: "endsAt has not passed yet -- a live commitment, never a repair candidate" };
  }
  const otherFutureBooked = allForLead.filter((a) => a.id !== appointment.id && a.status === "BOOKED" && new Date(a.ends_at) >= now);
  const otherPastBooked = allForLead.filter((a) => a.id !== appointment.id && a.status === "BOOKED" && new Date(a.ends_at) < now);
  if (otherFutureBooked.length === 1 && otherPastBooked.length === 0) {
    return {
      appointment, classification: "SAFE_TO_EXPIRE",
      reason: `endsAt has passed AND exactly one other BOOKED appointment for this lead is still future/current (id ${otherFutureBooked[0].id.slice(-8)}) -- unambiguous orphan`,
    };
  }
  return {
    appointment, classification: "AMBIGUOUS",
    reason: `endsAt has passed, but no single clear replacement was found (otherFutureBooked=${otherFutureBooked.length}, otherPastBooked=${otherPastBooked.length}) -- needs human review, never auto-repaired`,
  };
}

// -------------------------------------------------------------------------------------------
// CLI argument parsing -- pure, no I/O, fully unit-testable.
// -------------------------------------------------------------------------------------------

export interface ParsedArgs {
  mode: "dry-run" | "apply";
  leadId?: string;
  appointmentId?: string;
}
export type ParseResult = { ok: true; args: ParsedArgs } | { ok: false; error: string };

function readFlagValue(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

export function parseArgs(argv: string[]): ParseResult {
  const apply = argv.includes("--apply");
  const dryRunFlag = argv.includes("--dry-run");
  if (apply && dryRunFlag) return { ok: false, error: "Cannot pass both --apply and --dry-run -- pick exactly one." };
  const mode: "dry-run" | "apply" = apply ? "apply" : "dry-run";

  const leadId = readFlagValue(argv, "--lead-id");
  const appointmentId = readFlagValue(argv, "--appointment-id");

  if (leadId !== undefined && !isValidUuid(leadId)) return { ok: false, error: `--lead-id is not a valid UUID: "${leadId}"` };
  if (appointmentId !== undefined && !isValidUuid(appointmentId)) return { ok: false, error: `--appointment-id is not a valid UUID: "${appointmentId}"` };

  if (mode === "apply" && !leadId && !appointmentId) {
    return { ok: false, error: "--apply requires --lead-id or --appointment-id -- refusing to run an untargeted (potentially mass) repair." };
  }

  return { ok: true, args: { mode, leadId, appointmentId } };
}

// -------------------------------------------------------------------------------------------
// I/O boundary -- injectable so the planning/apply logic below is testable with an in-memory
// fake, never a real Supabase call in tests.
// -------------------------------------------------------------------------------------------

export interface RepairIO {
  getAllBooked(): Promise<AppointmentRow[]>;
  getAppointmentsForLead(leadId: string): Promise<AppointmentRow[]>;
  getAppointment(id: string): Promise<AppointmentRow | null>;
  /** Same contract as AppointmentRepository.claimTransition: true if this call won the
   * compare-and-set, false if the row's status no longer matched `expectedStatus`. */
  claimTransition(id: string, expectedStatus: string, nextStatus: string): Promise<boolean>;
  insertHistory(row: { appointment_id: string; lead_id: string; from_status: string; to_status: string; event_type: string; metadata: Record<string, unknown> }): Promise<void>;
}

// -------------------------------------------------------------------------------------------
// Planning -- read-only. Resolves EXACTLY what --apply would be allowed to touch, and why
// anything else in scope is being left alone. Used for both dry-run reporting and to compute
// the --apply target list (never the other way around -- --apply's target list is always a
// PLAN result, never re-derived ad hoc).
// -------------------------------------------------------------------------------------------

export type PlanResult =
  | { kind: "REJECTED"; reason: string }
  | { kind: "PLAN"; scope: "ALL" | "LEAD" | "APPOINTMENT"; rows: ClassifiedRow[]; targets: ClassifiedRow[] };

export async function planRepair(args: ParsedArgs, io: RepairIO, now: Date): Promise<PlanResult> {
  if (args.appointmentId) {
    const appointment = await io.getAppointment(args.appointmentId);
    if (!appointment) return { kind: "REJECTED", reason: `No appointment found with id ${args.appointmentId}` };
    if (args.leadId && appointment.lead_id !== args.leadId) {
      return { kind: "REJECTED", reason: `Appointment ${args.appointmentId} does not belong to lead ${args.leadId} (belongs to ${appointment.lead_id})` };
    }
    const siblings = await io.getAppointmentsForLead(appointment.lead_id);
    const row = classify(appointment, siblings, now);
    const targets = row.classification === "SAFE_TO_EXPIRE" ? [row] : [];
    return { kind: "PLAN", scope: "APPOINTMENT", rows: [row], targets };
  }

  if (args.leadId) {
    const rows = await io.getAppointmentsForLead(args.leadId);
    const classified = rows.map((r) => classify(r, rows, now));
    const targets = classified.filter((r) => r.classification === "SAFE_TO_EXPIRE");
    return { kind: "PLAN", scope: "LEAD", rows: classified, targets };
  }

  // No filter -- global listing. Only ever reachable in dry-run mode (parseArgs already rejects
  // --apply with no filter before this function is even called).
  const bookedRows = await io.getAllBooked();
  const leadIds = [...new Set(bookedRows.map((r) => r.lead_id))];
  const byLead = new Map<string, AppointmentRow[]>();
  for (const leadId of leadIds) byLead.set(leadId, await io.getAppointmentsForLead(leadId));
  const classified = bookedRows.map((r) => classify(r, byLead.get(r.lead_id) ?? [], now));
  return { kind: "PLAN", scope: "ALL", rows: classified, targets: [] }; // global scope is display-only, never an apply target list
}

// -------------------------------------------------------------------------------------------
// Apply -- writes ONLY the rows in `targets`, and only after re-reading + re-classifying each
// one fresh immediately before its write (never trusting the plan's earlier snapshot), then
// going through the same CAS the app itself uses as a second, independent safety layer.
// -------------------------------------------------------------------------------------------

export type ApplyOutcome = { appointmentId: string; result: "EXPIRED" | "SKIPPED_NO_LONGER_SAFE" | "SKIPPED_CAS_LOST" };

export async function applyTargets(targets: ClassifiedRow[], io: RepairIO, now: Date): Promise<ApplyOutcome[]> {
  const outcomes: ApplyOutcome[] = [];
  for (const target of targets) {
    const id = target.appointment.id;
    // Re-read + re-classify from scratch -- never trust the plan snapshot for the actual write
    // decision, only for having told the operator what to expect.
    const fresh = await io.getAppointment(id);
    if (!fresh) { outcomes.push({ appointmentId: id, result: "SKIPPED_NO_LONGER_SAFE" }); continue; }
    const siblings = await io.getAppointmentsForLead(fresh.lead_id);
    const reclassified = classify(fresh, siblings, now);
    if (reclassified.classification !== "SAFE_TO_EXPIRE") {
      outcomes.push({ appointmentId: id, result: "SKIPPED_NO_LONGER_SAFE" });
      continue;
    }
    const claimed = await io.claimTransition(id, "BOOKED", "EXPIRED");
    if (!claimed) { outcomes.push({ appointmentId: id, result: "SKIPPED_CAS_LOST" }); continue; }
    await io.insertHistory({
      appointment_id: id, lead_id: fresh.lead_id, from_status: "BOOKED", to_status: "EXPIRED", event_type: EXPIRE_EVENT_TYPE,
      metadata: { repairTool: "scripts/repair-orphaned-appointments.ts", reason: reclassified.reason },
    });
    outcomes.push({ appointmentId: id, result: "EXPIRED" });
  }
  return outcomes;
}

// -------------------------------------------------------------------------------------------
// Real Supabase-backed IO + CLI entrypoint. Never imported/executed by tests -- only reached
// when this file is run directly (see the isMainModule guard at the bottom).
// -------------------------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

function makeSupabaseIO(baseUrl: string, key: string): RepairIO {
  async function get(path: string): Promise<unknown> {
    const res = await fetch(`${baseUrl}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  }
  return {
    async getAllBooked() {
      return (await get("appointments?status=eq.BOOKED&select=*")) as AppointmentRow[];
    },
    async getAppointmentsForLead(leadId: string) {
      return (await get(`appointments?lead_id=eq.${leadId}&select=*`)) as AppointmentRow[];
    },
    async getAppointment(id: string) {
      const rows = (await get(`appointments?id=eq.${id}&select=*`)) as AppointmentRow[];
      return rows[0] ?? null;
    },
    async claimTransition(id: string, expectedStatus: string, nextStatus: string) {
      const res = await fetch(`${baseUrl}/rest/v1/appointments?id=eq.${id}&status=eq.${expectedStatus}`, {
        method: "PATCH",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (!res.ok) throw new Error(`PATCH appointments/${id} -> ${res.status} ${await res.text()}`);
      const data = (await res.json()) as unknown[];
      return data.length === 1; // 0 rows back means the CAS lost the race -- not an error
    },
    async insertHistory(row) {
      const res = await fetch(`${baseUrl}/rest/v1/appointment_status_history`, {
        method: "POST",
        headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(row),
      });
      if (!res.ok) throw new Error(`POST appointment_status_history -> ${res.status} ${await res.text()}`);
    },
  };
}

function printPlan(plan: Extract<PlanResult, { kind: "PLAN" }>): void {
  const byClass: Record<Classification, ClassifiedRow[]> = { SAFE_TO_EXPIRE: [], AMBIGUOUS: [], FUTURE: [], ALREADY_TERMINAL: [] };
  for (const r of plan.rows) byClass[r.classification].push(r);
  console.log(`scope: ${plan.scope}`);
  for (const [cls, rows] of Object.entries(byClass) as [Classification, ClassifiedRow[]][]) {
    console.log(`\n=== ${cls} (${rows.length}) ===`);
    for (const r of rows) console.log(`- appointment ${r.appointment.id.slice(-8)} (lead ${r.appointment.lead_id.slice(-8)}): ${r.reason}`);
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`REJECTED: ${parsed.error}`);
    process.exit(1);
  }
  const { args } = parsed;
  const baseUrl = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SECRET_KEY");
  const io = makeSupabaseIO(baseUrl, key);
  const now = new Date();

  console.log(`Fase 7H.1 repair tool -- mode: ${args.mode === "apply" ? "APPLY" : "DRY-RUN (read-only)"}${args.leadId ? `, lead-id=${args.leadId}` : ""}${args.appointmentId ? `, appointment-id=${args.appointmentId}` : ""}`);
  console.log(`now = ${now.toISOString()}\n`);

  const plan = await planRepair(args, io, now);
  if (plan.kind === "REJECTED") {
    console.error(`REJECTED: ${plan.reason}`);
    process.exit(1);
  }
  printPlan(plan);

  if (args.mode === "dry-run") {
    console.log(`\nDry-run complete. No writes performed.${plan.scope === "ALL" ? " Re-run with --apply --lead-id <uuid> or --apply --appointment-id <uuid> to expire a specific target." : ""}`);
    return;
  }

  console.log(`\nApplying: ${plan.targets.length} target(s) in scope...`);
  const outcomes = await applyTargets(plan.targets, io, now);
  for (const o of outcomes) console.log(`- appointment ${o.appointmentId.slice(-8)}: ${o.result}`);
}

const isMainModule = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
