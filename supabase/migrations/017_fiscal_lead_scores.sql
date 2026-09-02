-- Fase 6A: fiscal lead scoring (fiscal_v1) -- a deliberately SEPARATE table from `lead_scores`.
--
-- `lead_scores` (migration 005/008) is tightly coupled, at the application-type level, to the
-- WhatsApp conversational qualifier: LeadScoreRecord.vertical is QualificationVertical
-- ("PATRIMONIAL"|"GMM"), LeadScoreRecord.scoreClass is ScoreClass ("A"|"B"|"C") -- the SAME
-- vocabulary targetStatusForScore() reads to drive QUALIFIED_A/QUALIFIED_B/NURTURE_C lead-status
-- transitions -- and breakdown is typed Record<string, number|string> (no arrays). Reusing it for
-- a commercial HOT/WARM/NURTURE fiscal-calculator score would require widening those closed types
-- app-wide, and -- far worse -- a stray "HOT" landing in leads.score_class would silently corrupt
-- any code that reads it expecting "A"/"B"/"C" (concretely: WhatsAppBookingHandler.
-- abandonBookingPending calls targetStatusForScore(lead.scoreClass), which falls through to
-- NURTURE_C for any non-"A"/"B" value -- a genuinely hot fiscal lead would get silently
-- misclassified as low-priority the next time they abandon an unrelated booking flow). This is
-- exactly the kind of "reuse a field that already means something else" collision this task
-- explicitly warned about for the /api/leads/:id/score endpoint -- confirmed, by direct schema
-- inspection, to apply transitively to leads.score/leads.score_class and lead_scores too.
--
-- leads.score / leads.score_class / leads.status are therefore NEVER written by fiscal scoring --
-- this table is the sole source of truth for it, both as history (append-only, one row per
-- calculator submission) and as "current" (the most recent row for a lead, read by the WhatsApp
-- context bridge -- see fiscal-lead-context.ts).
create table if not exists fiscal_lead_scores (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  -- Same submissionId the caller already sends as Idempotency-Key (web-lead-capture.ts) --
  -- reused here as a second, scoring-specific idempotency guard: WebLeadCaptureService only ever
  -- attempts to insert a fiscal score on a genuine first-time processing of a submission (never on
  -- an idempotent replay), but this unique constraint is the actual, atomic guarantee against a
  -- duplicate score/history row even under a rare concurrent-race edge case.
  submission_id text not null,
  score integer not null,
  score_class text not null, -- 'HOT' | 'WARM' | 'NURTURE' -- deliberately NOT the 'A'/'B'/'C' vocabulary, see above
  version text not null default 'fiscal_v1',
  -- Reason codes explaining the score, e.g. [{"code":"MONTHLY_INCOME_50K_74K","points":24}, ...].
  -- Never PII: codes are closed, deterministic strings; points are integers.
  reasons jsonb not null default '[]'::jsonb,
  -- Bands, not exact amounts -- deliberately coarse-grained, safe to surface later in a WhatsApp
  -- conversational context bridge (see fiscal-lead-context.ts) without re-exposing exact income.
  monthly_income_band text not null,
  annual_contribution_band text not null,
  has_ppr boolean,
  files_annual_return boolean,
  created_at timestamptz not null default now(),
  unique (lead_id, submission_id)
);
create index if not exists fiscal_lead_scores_lead_id_idx on fiscal_lead_scores(lead_id);
alter table fiscal_lead_scores enable row level security;
