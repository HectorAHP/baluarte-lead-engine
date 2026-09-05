import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadRepository } from "../application/ports.js";
import type { Lead, LeadDedupKey } from "../domain/lead.js";

export interface LeadRow {
  id: string;
  created_at: string;
  updated_at: string;
  first_name: string | null;
  last_name: string | null;
  phone_raw: string | null;
  phone_e164: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  country: string;
  source: string | null;
  source_detail: string | null;
  meta_lead_id: string | null;
  whatsapp_user_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  ad_id: string | null;
  ad_name: string | null;
  product_vertical: string;
  product_interest: string | null;
  status: string;
  score: number;
  score_class: string | null;
  assigned_advisor: string;
  notes: string | null;
  consent_contact: boolean;
  privacy_accepted_at: string | null;
  first_contact_at: string | null;
  first_response_at: string | null;
  qualified_at: string | null;
  booking_started_at: string | null;
  booked_at: string | null;
  meeting_at: string | null;
  closed_at: string | null;
  email_quality: string | null;
  phone_quality: string | null;
  phone_verified_at: string | null;
  email_verified_at: string | null;
  identity_conflict: boolean | null;
  suspected_automation: boolean | null;
  lead_integrity_score: number | null;
  lead_integrity_version: string | null;
}

function toDateOrUndefined(value: string | null): Date | undefined {
  return value ? new Date(value) : undefined;
}

export function mapRowToLead(row: LeadRow): Lead {
  return {
    id: row.id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    firstName: row.first_name ?? undefined,
    lastName: row.last_name ?? undefined,
    phoneRaw: row.phone_raw ?? undefined,
    phoneE164: row.phone_e164 ?? undefined,
    email: row.email ?? undefined,
    city: row.city ?? undefined,
    state: row.state ?? undefined,
    country: row.country,
    source: row.source ?? undefined,
    sourceDetail: row.source_detail ?? undefined,
    metaLeadId: row.meta_lead_id ?? undefined,
    whatsappUserId: row.whatsapp_user_id ?? undefined,
    campaignId: row.campaign_id ?? undefined,
    campaignName: row.campaign_name ?? undefined,
    adsetId: row.adset_id ?? undefined,
    adsetName: row.adset_name ?? undefined,
    adId: row.ad_id ?? undefined,
    adName: row.ad_name ?? undefined,
    productVertical: row.product_vertical as Lead["productVertical"],
    productInterest: row.product_interest ?? undefined,
    status: row.status as Lead["status"],
    score: row.score,
    scoreClass: (row.score_class as Lead["scoreClass"]) ?? undefined,
    assignedAdvisor: row.assigned_advisor,
    notes: row.notes ?? undefined,
    consentContact: row.consent_contact,
    privacyAcceptedAt: toDateOrUndefined(row.privacy_accepted_at),
    firstContactAt: toDateOrUndefined(row.first_contact_at),
    firstResponseAt: toDateOrUndefined(row.first_response_at),
    qualifiedAt: toDateOrUndefined(row.qualified_at),
    bookingStartedAt: toDateOrUndefined(row.booking_started_at),
    bookedAt: toDateOrUndefined(row.booked_at),
    meetingAt: toDateOrUndefined(row.meeting_at),
    closedAt: toDateOrUndefined(row.closed_at),
    emailQuality: (row.email_quality as Lead["emailQuality"]) ?? undefined,
    phoneQuality: (row.phone_quality as Lead["phoneQuality"]) ?? undefined,
    phoneVerifiedAt: toDateOrUndefined(row.phone_verified_at),
    emailVerifiedAt: toDateOrUndefined(row.email_verified_at),
    identityConflict: row.identity_conflict ?? undefined,
    suspectedAutomation: row.suspected_automation ?? undefined,
    leadIntegrityScore: row.lead_integrity_score ?? undefined,
    leadIntegrityVersion: row.lead_integrity_version ?? undefined,
  };
}

export function mapLeadToInsertRow(input: Omit<Lead, "id" | "createdAt" | "updatedAt">) {
  return {
    first_name: input.firstName ?? null,
    last_name: input.lastName ?? null,
    phone_raw: input.phoneRaw ?? null,
    phone_e164: input.phoneE164 ?? null,
    email: input.email ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    country: input.country,
    source: input.source ?? null,
    source_detail: input.sourceDetail ?? null,
    meta_lead_id: input.metaLeadId ?? null,
    whatsapp_user_id: input.whatsappUserId ?? null,
    campaign_id: input.campaignId ?? null,
    campaign_name: input.campaignName ?? null,
    adset_id: input.adsetId ?? null,
    adset_name: input.adsetName ?? null,
    ad_id: input.adId ?? null,
    ad_name: input.adName ?? null,
    product_vertical: input.productVertical,
    product_interest: input.productInterest ?? null,
    status: input.status,
    score: input.score,
    score_class: input.scoreClass ?? null,
    assigned_advisor: input.assignedAdvisor,
    notes: input.notes ?? null,
    consent_contact: input.consentContact,
    privacy_accepted_at: input.privacyAcceptedAt?.toISOString() ?? null,
    first_contact_at: input.firstContactAt?.toISOString() ?? null,
    first_response_at: input.firstResponseAt?.toISOString() ?? null,
    qualified_at: input.qualifiedAt?.toISOString() ?? null,
    booking_started_at: input.bookingStartedAt?.toISOString() ?? null,
    booked_at: input.bookedAt?.toISOString() ?? null,
    meeting_at: input.meetingAt?.toISOString() ?? null,
    closed_at: input.closedAt?.toISOString() ?? null,
    email_quality: input.emailQuality ?? null,
    phone_quality: input.phoneQuality ?? null,
    phone_verified_at: input.phoneVerifiedAt?.toISOString() ?? null,
    email_verified_at: input.emailVerifiedAt?.toISOString() ?? null,
    identity_conflict: input.identityConflict ?? null,
    suspected_automation: input.suspectedAutomation ?? null,
    lead_integrity_score: input.leadIntegrityScore ?? null,
    lead_integrity_version: input.leadIntegrityVersion ?? null,
  };
}

export function mapLeadPatchToRow(patch: Partial<Lead>): Record<string, unknown> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.firstName !== undefined) row.first_name = patch.firstName;
  if (patch.lastName !== undefined) row.last_name = patch.lastName;
  if (patch.phoneRaw !== undefined) row.phone_raw = patch.phoneRaw;
  if (patch.phoneE164 !== undefined) row.phone_e164 = patch.phoneE164;
  if (patch.email !== undefined) row.email = patch.email;
  if (patch.city !== undefined) row.city = patch.city;
  if (patch.state !== undefined) row.state = patch.state;
  if (patch.country !== undefined) row.country = patch.country;
  if (patch.source !== undefined) row.source = patch.source;
  if (patch.sourceDetail !== undefined) row.source_detail = patch.sourceDetail;
  if (patch.metaLeadId !== undefined) row.meta_lead_id = patch.metaLeadId;
  if (patch.whatsappUserId !== undefined) row.whatsapp_user_id = patch.whatsappUserId;
  if (patch.campaignId !== undefined) row.campaign_id = patch.campaignId;
  if (patch.campaignName !== undefined) row.campaign_name = patch.campaignName;
  if (patch.adsetId !== undefined) row.adset_id = patch.adsetId;
  if (patch.adsetName !== undefined) row.adset_name = patch.adsetName;
  if (patch.adId !== undefined) row.ad_id = patch.adId;
  if (patch.adName !== undefined) row.ad_name = patch.adName;
  if (patch.productVertical !== undefined) row.product_vertical = patch.productVertical;
  if (patch.productInterest !== undefined) row.product_interest = patch.productInterest;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.score !== undefined) row.score = patch.score;
  if (patch.scoreClass !== undefined) row.score_class = patch.scoreClass;
  if (patch.assignedAdvisor !== undefined) row.assigned_advisor = patch.assignedAdvisor;
  if (patch.notes !== undefined) row.notes = patch.notes;
  if (patch.consentContact !== undefined) row.consent_contact = patch.consentContact;
  if (patch.privacyAcceptedAt !== undefined) row.privacy_accepted_at = patch.privacyAcceptedAt.toISOString();
  if (patch.firstContactAt !== undefined) row.first_contact_at = patch.firstContactAt.toISOString();
  if (patch.firstResponseAt !== undefined) row.first_response_at = patch.firstResponseAt.toISOString();
  if (patch.qualifiedAt !== undefined) row.qualified_at = patch.qualifiedAt.toISOString();
  if (patch.bookingStartedAt !== undefined) row.booking_started_at = patch.bookingStartedAt.toISOString();
  if (patch.bookedAt !== undefined) row.booked_at = patch.bookedAt.toISOString();
  if (patch.meetingAt !== undefined) row.meeting_at = patch.meetingAt.toISOString();
  if (patch.closedAt !== undefined) row.closed_at = patch.closedAt.toISOString();
  if (patch.emailQuality !== undefined) row.email_quality = patch.emailQuality;
  if (patch.phoneQuality !== undefined) row.phone_quality = patch.phoneQuality;
  if (patch.phoneVerifiedAt !== undefined) row.phone_verified_at = patch.phoneVerifiedAt.toISOString();
  if (patch.emailVerifiedAt !== undefined) row.email_verified_at = patch.emailVerifiedAt.toISOString();
  if (patch.identityConflict !== undefined) row.identity_conflict = patch.identityConflict;
  if (patch.suspectedAutomation !== undefined) row.suspected_automation = patch.suspectedAutomation;
  if (patch.leadIntegrityScore !== undefined) row.lead_integrity_score = patch.leadIntegrityScore;
  if (patch.leadIntegrityVersion !== undefined) row.lead_integrity_version = patch.leadIntegrityVersion;
  return row;
}

export class SupabaseLeadRepository implements LeadRepository {
  constructor(private readonly client: SupabaseClient) {}

  async create(input: Omit<Lead, "id" | "createdAt" | "updatedAt">): Promise<Lead> {
    const { data, error } = await this.client
      .from("leads")
      .insert(mapLeadToInsertRow(input))
      .select()
      .single();
    if (error) throw new Error(`SUPABASE_LEAD_CREATE_FAILED: ${error.message}`);
    return mapRowToLead(data as LeadRow);
  }

  async findById(id: string): Promise<Lead | null> {
    const { data, error } = await this.client.from("leads").select().eq("id", id).maybeSingle();
    if (error) throw new Error(`SUPABASE_LEAD_FIND_FAILED: ${error.message}`);
    return data ? mapRowToLead(data as LeadRow) : null;
  }

  async update(id: string, patch: Partial<Lead>): Promise<Lead> {
    const { data, error } = await this.client
      .from("leads")
      .update(mapLeadPatchToRow(patch))
      .eq("id", id)
      .select()
      .single();
    if (error) throw new Error(`SUPABASE_LEAD_UPDATE_FAILED: ${error.message}`);
    return mapRowToLead(data as LeadRow);
  }

  /**
   * Priority-ordered lookup: metaLeadId -> whatsappUserId -> phoneE164 -> email. Each is a
   * separate query, short-circuiting on the first hit, so a higher-priority match always wins
   * even if a lower-priority key would also match a different row.
   */
  async findByDedupKey(key: LeadDedupKey): Promise<Lead | null> {
    if (key.metaLeadId) {
      const hit = await this.findOneByColumn("meta_lead_id", key.metaLeadId);
      if (hit) return hit;
    }
    if (key.whatsappUserId) {
      const hit = await this.findOneByColumn("whatsapp_user_id", key.whatsappUserId);
      if (hit) return hit;
    }
    if (key.phoneE164) {
      const hit = await this.findOneByColumn("phone_e164", key.phoneE164);
      if (hit) return hit;
    }
    if (key.email) {
      const { data, error } = await this.client
        .from("leads")
        .select()
        .ilike("email", key.email)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`SUPABASE_LEAD_DEDUP_FAILED: ${error.message}`);
      if (data) return mapRowToLead(data as LeadRow);
    }
    return null;
  }

  private async findOneByColumn(column: string, value: string): Promise<Lead | null> {
    const { data, error } = await this.client.from("leads").select().eq(column, value).limit(1).maybeSingle();
    if (error) throw new Error(`SUPABASE_LEAD_DEDUP_FAILED: ${error.message}`);
    return data ? mapRowToLead(data as LeadRow) : null;
  }

  /** Fase 7B -- see LeadRepository.findByEmail's doc comment in ports.ts. */
  async findByEmail(email: string): Promise<Lead | null> {
    const { data, error } = await this.client.from("leads").select().ilike("email", email).limit(1).maybeSingle();
    if (error) throw new Error(`SUPABASE_LEAD_FIND_BY_EMAIL_FAILED: ${error.message}`);
    return data ? mapRowToLead(data as LeadRow) : null;
  }

  /** Fase 7B -- see LeadRepository.findByPhoneE164's doc comment in ports.ts. */
  async findByPhoneE164(phoneE164: string): Promise<Lead | null> {
    return this.findOneByColumn("phone_e164", phoneE164);
  }
}
