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
