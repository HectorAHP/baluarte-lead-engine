/**
 * Fase 7H -- repair tool for appointments left orphaned in status=BOOKED after their endsAt has
 * already passed (the root cause behind lead eb95060d's cancellation/reschedule incident: two
 * simultaneous "active" BOOKED rows made WhatsAppCancellationHandler/WhatsAppRescheduleHandler's
 * findTargetAppointment see ">1 active" and escalate every attempt to HUMAN_HANDOFF).
 *
 * AppointmentService.expirePriorStaleBookedAppointments (see src/application/services.ts) already
 * prevents this going forward -- it runs automatically before every NEW appointment is created.
 * This script is the one-time backstop for appointments that became orphaned BEFORE that fix
 * existed and will never get a "new booking" to trigger the automatic cleanup on their own (e.g. a
 * lead who never re-books at all).
 *
 * SAFE BY DESIGN:
 *  - --dry-run is the DEFAULT. Nothing is ever written unless --apply is passed explicitly.
 *  - Even with --apply, only rows classified SAFE_TO_EXPIRE are ever touched -- AMBIGUOUS rows are
 *    always left alone and printed for a human to review individually.
 *  - Never infers attendance: every write is BOOKED -> EXPIRED (see AppointmentStatus's own doc
 *    comment for why this is NOT COMPLETED/NO_SHOW), via the exact same CAS
 *    (`WHERE id=X AND status='BOOKED'`) AppointmentRepository.claimTransition uses, so a row that
 *    changed under us since the read (e.g. a real cancellation completing concurrently) is simply
 *    skipped, never overwritten.
 *  - Never touches Calendar. Never touches leads. Never touches a future/current appointment.
 *  - Every --apply write gets its own appointment_status_history row, eventType
 *    APPOINTMENT_EXPIRED_MANUAL_REPAIR -- deliberately DIFFERENT from the app's own automatic
 *    APPOINTMENT_EXPIRED_ON_REBOOK, so the audit trail always shows whether a given EXPIRED
 *    transition happened automatically (a real rebooking) or via this manual repair tool.
 *
 * Usage:
 *   npx tsx scripts/repair-orphaned-appointments.ts                # dry-run (default), reads only
 *   npx tsx scripts/repair-orphaned-appointments.ts --apply         # writes SAFE_TO_EXPIRE rows only
 *
 * Requires SUPABASE_URL and SUPABASE_SECRET_KEY in the environment (same convention as every other
 * script in this repo, e.g. scripts/bench-hubspot-capture.ts).
 */

interface AppointmentRow {
  id: string;
  lead_id: string;
  status: string;
  starts_at: string;
  ends_at: string;
  calendar_event_id: string | null;
  created_at: string;
}

type Classification = "SAFE_TO_EXPIRE" | "AMBIGUOUS" | "FUTURE" | "ALREADY_TERMINAL";

interface ClassifiedRow {
  appointment: AppointmentRow;
  classification: Classification;
  reason: string;
}

const EXPIRE_EVENT_TYPE = "APPOINTMENT_EXPIRED_MANUAL_REPAIR";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

async function supabaseGet(baseUrl: string, key: string, path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

/** Single-row compare-and-set PATCH, mirroring AppointmentRepository.claimTransition's exact
 * contract: only succeeds if the row's status still matches `expectedStatus` at write time. */
async function supabaseClaimTransition(baseUrl: string, key: string, id: string, expectedStatus: string, nextStatus: string): Promise<boolean> {
  const res = await fetch(`${baseUrl}/rest/v1/appointments?id=eq.${id}&status=eq.${expectedStatus}`, {
    method: "PATCH",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ status: nextStatus }),
  });
  if (!res.ok) throw new Error(`PATCH appointments/${id} -> ${res.status} ${await res.text()}`);
  const data = (await res.json()) as unknown[];
  return data.length === 1; // 0 rows back means the CAS lost the race (status already changed) -- not an error
}

async function supabaseInsertHistory(baseUrl: string, key: string, row: { appointment_id: string; lead_id: string; from_status: string; to_status: string; event_type: string; metadata: Record<string, unknown> }): Promise<void> {
  const res = await fetch(`${baseUrl}/rest/v1/appointment_status_history`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error(`POST appointment_status_history -> ${res.status} ${await res.text()}`);
}

function classify(appointment: AppointmentRow, allForLead: AppointmentRow[], now: Date): ClassifiedRow {
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

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const baseUrl = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SECRET_KEY");
  const now = new Date();

  console.log(`Fase 7H repair tool -- mode: ${apply ? "APPLY (will write SAFE_TO_EXPIRE rows)" : "DRY-RUN (read-only, default)"}`);
  console.log(`now = ${now.toISOString()}\n`);

  const bookedRows = (await supabaseGet(baseUrl, key, "appointments?status=eq.BOOKED&select=*")) as AppointmentRow[];
  const leadIds = [...new Set(bookedRows.map((r) => r.lead_id))];

  // Fetch every appointment (any status) for each lead that has at least one BOOKED row, so
  // classify() can see the full picture (other BOOKED rows, past or future) per lead.
  const allByLead = new Map<string, AppointmentRow[]>();
  for (const leadId of leadIds) {
    const rows = (await supabaseGet(baseUrl, key, `appointments?lead_id=eq.${leadId}&select=*`)) as AppointmentRow[];
    allByLead.set(leadId, rows);
  }

  const results: ClassifiedRow[] = bookedRows.map((row) => classify(row, allByLead.get(row.lead_id) ?? [], now));

  const byClass: Record<Classification, ClassifiedRow[]> = { SAFE_TO_EXPIRE: [], AMBIGUOUS: [], FUTURE: [], ALREADY_TERMINAL: [] };
  for (const r of results) byClass[r.classification].push(r);

  for (const [cls, rows] of Object.entries(byClass) as [Classification, ClassifiedRow[]][]) {
    console.log(`\n=== ${cls} (${rows.length}) ===`);
    for (const r of rows) {
      console.log(`- appointment ${r.appointment.id.slice(-8)} (lead ${r.appointment.lead_id.slice(-8)}): ${r.reason}`);
    }
  }

  if (!apply) {
    console.log("\nDry-run complete. No writes performed. Re-run with --apply to expire SAFE_TO_EXPIRE rows only.");
    return;
  }

  console.log(`\nApplying: expiring ${byClass.SAFE_TO_EXPIRE.length} SAFE_TO_EXPIRE row(s)...`);
  for (const r of byClass.SAFE_TO_EXPIRE) {
    const claimed = await supabaseClaimTransition(baseUrl, key, r.appointment.id, "BOOKED", "EXPIRED");
    if (!claimed) {
      console.log(`- appointment ${r.appointment.id.slice(-8)}: SKIPPED (status changed since the read -- lost the compare-and-set, left untouched)`);
      continue;
    }
    await supabaseInsertHistory(baseUrl, key, {
      appointment_id: r.appointment.id, lead_id: r.appointment.lead_id,
      from_status: "BOOKED", to_status: "EXPIRED", event_type: EXPIRE_EVENT_TYPE,
      metadata: { repairTool: "scripts/repair-orphaned-appointments.ts", reason: r.reason },
    });
    console.log(`- appointment ${r.appointment.id.slice(-8)}: EXPIRED, history row written`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
