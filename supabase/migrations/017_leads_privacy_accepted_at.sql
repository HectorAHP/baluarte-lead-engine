-- Web lead capture (fiscal calculator integration): tracks WHEN a lead accepted the Aviso de
-- Privacidad, separately from the pre-existing leads.consent_contact (marketing opt-in).
-- Additive, nullable, backwards compatible -- no existing row or query is affected. Reversible
-- via `alter table leads drop column privacy_accepted_at;` if ever needed.
alter table leads add column if not exists privacy_accepted_at timestamptz;
