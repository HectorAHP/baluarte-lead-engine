-- Phase 3B: rules_version becomes a first-class, queryable column instead of living only inside
-- the breakdown jsonb blob. Added nullable first so any pre-existing lead_scores rows (from the
-- manual /api/leads/:id/score endpoint, in use since Sprint 1) don't fail an insert-time
-- constraint; backfilled to an explicit 'legacy' marker; then tightened to NOT NULL so every row
-- from this point forward is required to carry it. Application code (LeadService) now always
-- supplies a value -- 'manual-scoring-legacy-v1' for the older endpoint,
-- 'PATRIMONIAL_QUALIFICATION_V1' / 'GMM_QUALIFICATION_V1' for the Phase 3B conversational
-- qualifier -- so this constraint reflects reality going forward, not just a migration-time
-- snapshot. No column removed, no existing row's id/created_at/total/score_class/breakdown
-- touched.
alter table lead_scores add column if not exists rules_version text;
update lead_scores set rules_version = 'legacy' where rules_version is null;
alter table lead_scores alter column rules_version set not null;
