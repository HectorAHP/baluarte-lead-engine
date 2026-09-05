import "dotenv/config"; import {z} from "zod";
const workdayTime=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/,"Expected HH:MM");
const schema=z.object({
  NODE_ENV:z.string().default("development"),
  PORT:z.coerce.number().default(3000),
  ADVISOR_TIMEZONE:z.string().default("America/Mexico_City"),
  MEETING_DURATION_MINUTES:z.coerce.number().default(30),
  BOOKING_MIN_NOTICE_HOURS:z.coerce.number().default(2),
  BOOKING_MAX_DAYS_AHEAD:z.coerce.number().default(14),
  WORKDAY_START:workdayTime.default("09:00"),
  WORKDAY_END:workdayTime.default("19:00"),
  SUPABASE_URL:z.preprocess((v)=>v===""?undefined:v,z.string().url().optional()),
  SUPABASE_SECRET_KEY:z.string().optional(),
  GOOGLE_CLIENT_ID:z.string().optional(),
  GOOGLE_CLIENT_SECRET:z.string().optional(),
  GOOGLE_REFRESH_TOKEN:z.string().optional(),
  GOOGLE_CALENDAR_ID:z.string().default("primary"),
  WHATSAPP_ACCESS_TOKEN:z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID:z.string().optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID:z.string().optional(),
  WHATSAPP_VERIFY_TOKEN:z.string().optional(),
  META_APP_SECRET:z.string().optional(),
  META_GRAPH_API_VERSION:z.string().default("v21.0"),
  // Phase 3B feature flag. Default false: with it unset/false, WhatsApp behavior stays exactly
  // Phase 2 (welcome message only, no qualification routing). Set to "true" only for a
  // controlled test -- never flip it in production .env without an explicit decision to do so.
  // Deliberately NOT z.coerce.boolean(): that coerces the *string* "false" to `true` (any
  // non-empty string is truthy in JS), which would silently invert this flag's default.
  QUALIFICATION_ENGINE_ENABLED:z.preprocess((v)=>v==="true",z.boolean()).default(false),
  // Phase 3C feature flag, independent of QUALIFICATION_ENGINE_ENABLED -- flipping this one
  // alone must not change behavior until a Phase 3C booking handler actually exists to read it.
  // Same safe-parsing rationale as above: never z.coerce.boolean().
  WHATSAPP_BOOKING_ENABLED:z.preprocess((v)=>v==="true",z.boolean()).default(false),
  // Phase 4B feature flag, independent of both flags above. false (default) leaves a BOOKED lead's
  // inbound messages with no automated reply, byte-for-byte identical to Phase 3C -- routing to
  // WhatsAppCancellationHandler only ever activates when this is explicitly "true". Same
  // safe-parsing rationale: never z.coerce.boolean().
  WHATSAPP_CANCELLATION_ENABLED:z.preprocess((v)=>v==="true",z.boolean()).default(false),
  // Phase 4C feature flag, independent of the three flags above. false (default) leaves a BOOKED
  // lead's inbound messages routed exactly as Phase 4B (cancellation-intent check only) -- routing
  // to WhatsAppRescheduleHandler only ever activates when this is explicitly "true". Same safe-
  // parsing rationale: never z.coerce.boolean().
  WHATSAPP_RESCHEDULE_ENABLED:z.preprocess((v)=>v==="true",z.boolean()).default(false),
  // Fase 7A feature flags -- independent of every flag above and of each other, same safe-parsing
  // rationale (never z.coerce.boolean()). false (default) leaves the entire reminders/confirmation/
  // follow-up/no-show surface byte-for-byte inert: no sweep runs, no confirmation branch is ever
  // checked, no admin transition sends a message. See docs/PHASE4-DESIGN.md and the Fase 7A report.
  APPOINTMENT_REMINDERS_ENABLED:z.preprocess((v)=>v==="true",z.boolean()).default(false),
  POST_MEETING_FOLLOWUP_ENABLED:z.preprocess((v)=>v==="true",z.boolean()).default(false),
  // Reserved for a future *automatic nudge to Héctor* on an unconfirmed past appointment -- no
  // code reads this yet (see AppointmentCompletionService's class doc comment: mark-completed/
  // mark-no-show are Héctor-driven, not gated by this flag at all). Added now, per the Fase 7A
  // spec, so the env surface for the eventual automatic-nudge slice is already reserved.
  NO_SHOW_DETECTION_ENABLED:z.preprocess((v)=>v==="true",z.boolean()).default(false),
  // Gates WhatsAppAppointmentConfirmationHandler (see whatsapp-inbound-service.ts) -- independent
  // of APPOINTMENT_REMINDERS_ENABLED because a confirmation reply can only ever be interpreted
  // AFTER a 24h reminder was actually sent; leaving them separately toggleable lets a future
  // rollout enable reminders without yet trusting the confirmation-reply parser, or vice versa.
  APPOINTMENT_CONFIRMATION_ENABLED:z.preprocess((v)=>v==="true",z.boolean()).default(false),
  // Fase 7A -- Meta Message Template names (WhatsApp Business requires a pre-approved template for
  // any business-initiated message sent outside the 24h customer-service window -- see
  // MessagingProvider.sendTemplate). Configurable by design (Fase 7A spec item 3: "no hardcodear
  // necesariamente nombres de producción") -- defaults match the exact names proposed for Héctor to
  // submit to Meta Business Manager (see the Fase 7A report), but never assumed approved: sending
  // fails loudly (MessagingProviderError, delivery row left FAILED) until Meta actually approves
  // whatever name ends up configured here.
  WHATSAPP_TEMPLATE_REMINDER_24H:z.string().default("recordatorio_24h"),
  WHATSAPP_TEMPLATE_REMINDER_2H:z.string().default("recordatorio_2h"),
  WHATSAPP_TEMPLATE_POST_MEETING:z.string().default("seguimiento_post_cita"),
  WHATSAPP_TEMPLATE_NO_SHOW:z.string().default("no_show_nudge"),
  // Meta locale code for every template above -- "es_MX" (not "es"/"es-MX") is Meta's own
  // documented format for Mexican Spanish in the Template API.
  WHATSAPP_TEMPLATE_LANGUAGE:z.string().default("es_MX"),
  // Fase 7A -- static bearer secret for POST /internal/reminders/run (Fase 7A spec item 10:
  // "Authorization: Bearer <REMINDER_RUNNER_SECRET>"). Optional/undefined fails the route closed
  // (401, same "no secret configured -> nothing can be trusted" posture as META_APP_SECRET's own
  // webhook check in app.ts) -- never a default value, since a default would BE the shared secret.
  REMINDER_RUNNER_SECRET:z.string().optional(),
  // Fase 7A -- static header token (`x-admin-token`, compared via timingSafeEqualStrings) for the
  // two admin endpoints (mark-completed/mark-no-show). Same fail-closed-when-unset posture as
  // REMINDER_RUNNER_SECRET above. Minimal viable admin auth, exactly as docs/PHASE4-DESIGN.md §18
  // already flagged as the accepted risk pending a stronger scheme if this project's needs grow.
  ADMIN_API_TOKEN:z.string().optional(),

  // Fase 7B -- lead integrity / anti-fake-lead feature flags. ALL default false ("passive" per the
  // Fase 7B rollout plan, Phase A) -- with every one false, POST /api/leads' behavior is
  // byte-for-byte unchanged from before this phase: no email/phone quality is computed or stored,
  // no honeypot field is enforced, no DNS lookup ever runs. A low score / a detected issue NEVER
  // blocks a real lead, changes its status/fiscal_v1/HOT-WARM-NURTURE, or gates WhatsApp messaging
  // eligibility on its own -- see domain/lead-integrity-score.ts's class doc comment for the full
  // list of things this must never be used to decide.
  LEAD_INTEGRITY_ENABLED:z.preprocess((v)=>v==="true",z.boolean()).default(false),
  // Independent of LEAD_INTEGRITY_ENABLED's other computations -- gates ONLY the optional DNS
  // domain-existence check (see infrastructure/dns-email-domain-checker.ts). Off by default: a DNS
  // lookup is the one piece of this phase with real external-network/latency risk, so it needs its
  // own explicit opt-in even after LEAD_INTEGRITY_ENABLED is on.
  EMAIL_DNS_VALIDATION_ENABLED:z.preprocess((v)=>v==="true",z.boolean()).default(false),
  // Gates whether classifyEmailQuality ever checks the disposable-domain denylist at all -- off by
  // default so a real disposable-provider user is never even tagged until this is deliberately
  // turned on (Fase 7B rollout Phase B).
  DISPOSABLE_EMAIL_CHECK_ENABLED:z.preprocess((v)=>v==="true",z.boolean()).default(false),
  // Extra disposable domains to merge with DEFAULT_DISPOSABLE_EMAIL_DOMAINS (email-quality.ts) --
  // comma-separated, e.g. "example-temp.com,another.net". Optional; empty/unset adds nothing.
  EMAIL_DISPOSABLE_DOMAINS_EXTRA:z.string().optional(),
  // Gates whether POST /api/leads' honeypot field (see app.ts) is actually enforced. Off by
  // default: the field is always ACCEPTED (a real browser never fills it either way), but with
  // this false, a filled honeypot is simply ignored -- no different from any other field -- rather
  // than short-circuiting the request. Fase 7B rollout Phase B.
  HONEYPOT_ENABLED:z.preprocess((v)=>v==="true",z.boolean()).default(false),
  // Reserved for a future slice that would require phone/WhatsApp verification (or an equivalent
  // trust signal) before an automated booking action -- no code reads this yet (see the Fase 7B
  // report's explicit "not built" list, same "flag added, nothing wired yet" precedent as
  // NO_SHOW_DETECTION_ENABLED in Fase 7A). Deliberately NOT wired into WhatsAppBookingHandler/
  // SlotOfferingService in this phase -- doing so without real QA risks breaking the
  // well-tested, already-working booking flow, which this task's "NO romper ningún flujo
  // funcional existente" rule takes priority over.
  STRICT_BOOKING_INTEGRITY_ENABLED:z.preprocess((v)=>v==="true",z.boolean()).default(false),
  // Production hardening (web lead capture / POST /api/leads). Comma-separated origin allowlist
  // for @fastify/cors -- optional because a sensible NODE_ENV-based default (see
  // corsAllowedOrigins below) covers the common case without requiring an env var in every
  // environment. Explicit env var always wins when set, in either environment.
  CORS_ALLOWED_ORIGINS:z.string().optional(),
  // POST /api/leads rate limit (per IP). Deliberately generous defaults -- see corsAllowedOrigins'
  // sibling comment: this guards against abuse, not against a shared office/NAT submitting the
  // fiscal calculator a handful of times in a minute.
  LEADS_RATE_LIMIT_MAX:z.coerce.number().int().positive().default(20),
  LEADS_RATE_LIMIT_WINDOW_MS:z.coerce.number().int().positive().default(60_000),
  // Fase 6F -- HubSpot CRM sync. Optional: absent (the only state in every environment today --
  // see the Fase 6F report's "variables Render" section) means hasHubSpotCredentials is false and
  // app.ts never constructs a real HubSpotCRMProvider, so POST /api/leads' HubSpot sync step is a
  // silent no-op everywhere until this is explicitly set. HUBSPOT_PORTAL_ID is NOT required by any
  // API call this integration makes (a Private App token already scopes every request to its own
  // portal) -- kept only for documentation/manual-link purposes, never read by hubspot-crm-provider.ts.
  HUBSPOT_PRIVATE_APP_TOKEN:z.string().optional(),
  HUBSPOT_PORTAL_ID:z.string().optional(),
}).superRefine((cfg,ctx)=>{
  const googleFields=[cfg.GOOGLE_CLIENT_ID,cfg.GOOGLE_CLIENT_SECRET,cfg.GOOGLE_REFRESH_TOKEN];
  const setCount=googleFields.filter(Boolean).length;
  if(setCount>0&&setCount<3){
    ctx.addIssue({code:z.ZodIssueCode.custom,message:"GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN must all be set together, or all left empty"});
  }
});
export const config=schema.parse(process.env);
export const hasGoogleCalendarCredentials=Boolean(config.GOOGLE_CLIENT_ID&&config.GOOGLE_CLIENT_SECRET&&config.GOOGLE_REFRESH_TOKEN);
export const hasWhatsAppCredentials=Boolean(config.WHATSAPP_ACCESS_TOKEN&&config.WHATSAPP_PHONE_NUMBER_ID&&config.WHATSAPP_VERIFY_TOKEN&&config.META_APP_SECRET);
export const hasHubSpotCredentials=Boolean(config.HUBSPOT_PRIVATE_APP_TOKEN);

// Production hardening: CORS allowlist for the public web surface (POST /api/leads and friends --
// PII/financial data). CORS is a browser-enforced concept; server-to-server callers (Meta's
// WhatsApp webhook, a future Lead Engine-to-Lead-Engine call) never send an Origin header at all,
// so they are entirely unaffected by this allowlist -- see app.ts's cors registration.
const DEFAULT_PROD_CORS_ORIGINS=["https://baluartecapital.com.mx","https://www.baluartecapital.com.mx"];
// Local dev origins actually used by this project: this repo's own `npm run dev` (PORT, default
// 3000) for same-origin tooling/curl, plus the baluarte-capital static site's two documented local
// preview ports (python http.server on 8765 per that repo's .claude/launch.json, and the 5500
// Live-Server-style default some editors use). Never used in production (see the branch below).
const DEFAULT_DEV_CORS_ORIGINS=["http://localhost:3000","http://127.0.0.1:3000","http://localhost:5500","http://127.0.0.1:5500","http://localhost:8765","http://127.0.0.1:8765"];
export const corsAllowedOrigins:string[]=config.CORS_ALLOWED_ORIGINS
  ? config.CORS_ALLOWED_ORIGINS.split(",").map((o)=>o.trim()).filter(Boolean)
  : config.NODE_ENV==="production" ? DEFAULT_PROD_CORS_ORIGINS : DEFAULT_DEV_CORS_ORIGINS;

// Fase 7B -- see EMAIL_DISPOSABLE_DOMAINS_EXTRA's own doc comment above.
export const extraDisposableEmailDomains:ReadonlySet<string> = config.EMAIL_DISPOSABLE_DOMAINS_EXTRA
  ? new Set(config.EMAIL_DISPOSABLE_DOMAINS_EXTRA.split(",").map((d)=>d.trim().toLowerCase()).filter(Boolean))
  : new Set();
