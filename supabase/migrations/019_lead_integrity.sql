-- Fase 7B -- lead integrity / anti-fake-lead technical fields. Purely additive: every column is
-- nullable with no default other than NULL, so every existing row (and every existing INSERT that
-- doesn't mention these columns) is completely unaffected. No existing migration is modified.
--
-- Deliberately separate from fiscal_v1 (fiscal_lead_scores, migration 018) and from
-- leads.score/score_class (the WhatsApp qualifier's own HOT/WARM/NURTURE scoring) -- see
-- domain/lead-integrity-score.ts's class doc comment for the full "kept separate from" list. No
-- code in this codebase reads these columns to make a status/scoring/messaging-eligibility
-- decision as of this migration -- they are computed and stored (only when LEAD_INTEGRITY_ENABLED
-- is true, see config.ts) for observability and future, deliberate use, never wired to block or
-- reclassify a lead automatically.
--
-- Rollback: `alter table leads drop column if exists <name>;` for each column below, in any order
-- (none of them are referenced by a foreign key, index used elsewhere, or RLS policy) -- safe at
-- any time, including with rows already populated (their values are simply lost, nothing else is
-- affected).
alter table leads add column if not exists email_quality text; -- 'VALID' | 'INVALID' | 'DISPOSABLE' | 'UNVERIFIED', see domain/email-quality.ts
alter table leads add column if not exists phone_quality text; -- 'VALID' | 'INVALID' | 'UNVERIFIED' | 'VERIFIED', see domain/phone-quality.ts
alter table leads add column if not exists phone_verified_at timestamptz; -- set once, by whatsapp-inbound-service.ts's passive verification step only
alter table leads add column if not exists email_verified_at timestamptz; -- reserved for a future confirmation-link flow (Fase 7B spec item 33) -- no writer exists yet
alter table leads add column if not exists identity_conflict boolean; -- see WebLeadCaptureService.resolveExistingLead / RealHubSpotCRMProvider's identity-conflict detection
alter table leads add column if not exists suspected_automation boolean; -- see domain/form-timing.ts
alter table leads add column if not exists lead_integrity_score integer; -- 0-100, see domain/lead-integrity-score.ts
alter table leads add column if not exists lead_integrity_version text; -- always 'lead_integrity_v1' for now, stored so a future rule change never silently reinterprets an old score

-- No new index: none of these columns is used as a lookup/filter key by any query in this
-- codebase today (email/phone lookups continue to use the pre-existing email/phone_e164 columns
-- and their own indexes, unaffected by this migration). Add one if/when a real query needs it.
