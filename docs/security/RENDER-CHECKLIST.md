# Render — manual checklist (Fase 7B)

**Nothing in this file has been applied.** This session has not touched Render. Everything below
is a checklist for Héctor (or whoever holds the Render dashboard) to work through manually, in
order, before or during a real rollout. No code change requires any of this to exist first —
every new flag defaults to `false`/absent and the server runs identically without any of it set.

## 1. New environment variables (Fase 7A, carried forward)

Already documented in `.env.example`; restated here because a Render rollout is the first time
they'd actually be set for real:

| Variable | Purpose | Generate with |
|---|---|---|
| `REMINDER_RUNNER_SECRET` | Bearer token for `POST /internal/reminders/run` | `openssl rand -hex 32` |
| `ADMIN_API_TOKEN` | `x-admin-token` for the two `/api/appointments/:id/mark-*` routes | `openssl rand -hex 32` |
| `WHATSAPP_TEMPLATE_REMINDER_24H` / `_2H` / `_POST_MEETING` / `_NO_SHOW` | Meta template names | (see Fase 7A report) |
| `WHATSAPP_TEMPLATE_LANGUAGE` | `es_MX` | — |

## 2. New environment variables (Fase 7B)

All optional; every one absent = the exact behavior this app already has today.

| Variable | Default | What it turns on |
|---|---|---|
| `LEAD_INTEGRITY_ENABLED` | `false` | email/phone quality classification, suspectedAutomation, identityConflict persistence, leadIntegrityScore, WhatsApp passive phone verification |
| `EMAIL_DNS_VALIDATION_ENABLED` | `false` | the optional MX/A/AAAA domain check (only matters if `LEAD_INTEGRITY_ENABLED=true`) |
| `DISPOSABLE_EMAIL_CHECK_ENABLED` | `false` | disposable-domain tagging (only matters if `LEAD_INTEGRITY_ENABLED=true`) |
| `EMAIL_DISPOSABLE_DOMAINS_EXTRA` | unset | comma-separated extra domains merged into the built-in denylist |
| `HONEYPOT_ENABLED` | `false` | actually rejects a filled honeypot field (the field is always accepted structurally either way) |
| `STRICT_BOOKING_INTEGRITY_ENABLED` | `false` | **reserved — no code reads this yet.** Setting it to `true` today has zero effect. |

**Do not set any of these to `true` on first deploy of this branch.** Confirm the deploy itself is
healthy (see §5) with every Fase 7B flag still `false` first.

## 3. Secret rotation checklist

Run through this BEFORE relying on any of these secrets in production, and again any time one may
have been exposed (pasted into a chat, shown on a screen-share, committed by mistake, etc.):

- [ ] `META_APP_SECRET` — rotate in Meta App Dashboard → Settings → Basic, update Render env var,
      redeploy. **High priority** if this was ever pasted anywhere during WhatsApp webhook
      troubleshooting this project has done in prior phases — check your own chat/terminal history.
- [ ] `WHATSAPP_ACCESS_TOKEN` — rotate in Meta Business Settings → System Users (or the app's own
      token generator for a temporary token). Same "check troubleshooting history" note.
- [ ] `WHATSAPP_VERIFY_TOKEN` — this one is chosen by you, not Meta-issued; just pick a new random
      value in both Render and the Meta webhook config at the same time (a mismatch breaks webhook
      verification until both sides agree again).
- [ ] `HUBSPOT_PRIVATE_APP_TOKEN` — rotate in HubSpot → Settings → Integrations → Private Apps →
      \[the app\] → rotate.
- [ ] `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` — rotate via Google Cloud Console (OAuth
      client secret) and re-run the refresh-token grant flow; the refresh token specifically should
      rotate if it was ever displayed in a terminal that was screen-shared or recorded.
- [ ] `SUPABASE_SECRET_KEY` (service role) — rotate in Supabase → Project Settings → API. This is
      the single most powerful secret in this system (bypasses RLS entirely) — prioritize this one
      first if in doubt.
- [ ] `REMINDER_RUNNER_SECRET` / `ADMIN_API_TOKEN` — brand new in this phase; generate fresh values
      now rather than reusing anything typed during development/testing.

This session performed no scan of actual git history/logs for exposed secrets (no access to
Render's own logs or this machine's shell history) — treat the list above as "rotate on the
assumption that development-time exposure is possible", not as a confirmed-exposed list.

## 4. Scheduler for `POST /internal/reminders/run`

Pick ONE (the endpoint itself doesn't care which):

- **Render Cron Job** (if available on the current plan) — simplest, one Render resource, hits
  `https://<service>.onrender.com/internal/reminders/run` with `Authorization: Bearer
  $REMINDER_RUNNER_SECRET` every 15 minutes.
- **cron-job.org** (or similar free HTTP-cron service) — set the same header, same interval, if
  Render's own plan doesn't include Cron Jobs.
- **GitHub Actions scheduled workflow** — fallback if neither of the above is preferred; needs the
  secret stored as a GitHub Actions secret, never committed.

Whichever is chosen, test it manually first with `curl` (or Postman) before wiring the schedule,
confirming a 200 with the expected `{ok:true, reminder24h:{...}, ...}` shape and a 401 with a wrong
token.

## 5. Health check

Render's own health check should already point at `GET /health` (confirm in the service's Settings
→ Health Check Path). After this deploy, `/health`'s response shape is UNCHANGED — no Fase 7A/7B
field was added to it — so no Render-side health-check config change is needed.

## 6. Service restart

A plain `git push`/Render auto-deploy already restarts the service. No extra manual restart step
is needed for env var changes to take effect — Render restarts on every env var save by default
(confirm this hasn't been disabled for this service).

## 7. Rate limits

No Render-side configuration needed — every rate limit in this phase is enforced inside the
Fastify app itself (in-memory, per-process — see `src/app.ts`'s own `@fastify/rate-limit`
registration comment for why a distributed store isn't used). If this service is ever scaled to
more than one Render instance, revisit that comment before assuming rate limits still hold
per-caller across instances.
