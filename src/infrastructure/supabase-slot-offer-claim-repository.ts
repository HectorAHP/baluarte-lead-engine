import type { SupabaseClient } from "@supabase/supabase-js";
import type { SlotOfferClaimRepository } from "../application/ports.js";
import type { SlotOfferClaim } from "../domain/slot-offer-claim.js";

export interface SlotOfferClaimRow {
  conversation_id: string;
  owner_token: string;
  intended_round_id: string;
  claimed_at: string;
  updated_at: string;
}

export function mapRowToSlotOfferClaim(row: SlotOfferClaimRow): SlotOfferClaim {
  return {
    conversationId: row.conversation_id,
    ownerToken: row.owner_token,
    intendedRoundId: row.intended_round_id,
    claimedAt: new Date(row.claimed_at),
    updatedAt: new Date(row.updated_at),
  };
}

export class SupabaseSlotOfferClaimRepository implements SlotOfferClaimRepository {
  constructor(private readonly client: SupabaseClient) {}

  async tryCreate(input: { conversationId: string; ownerToken: string; intendedRoundId: string }): Promise<SlotOfferClaim | null> {
    const { data, error } = await this.client
      .from("slot_offer_claims")
      .insert({ conversation_id: input.conversationId, owner_token: input.ownerToken, intended_round_id: input.intendedRoundId })
      .select()
      .single();
    if (error) {
      if (error.code === "23505") return null; // lost the race -- another request already claimed this conversation
      throw new Error(`SUPABASE_SLOT_OFFER_CLAIM_CREATE_FAILED: ${error.message}`);
    }
    return mapRowToSlotOfferClaim(data as SlotOfferClaimRow);
  }

  async findByConversationId(conversationId: string): Promise<SlotOfferClaim | null> {
    const { data, error } = await this.client.from("slot_offer_claims").select().eq("conversation_id", conversationId).maybeSingle();
    if (error) throw new Error(`SUPABASE_SLOT_OFFER_CLAIM_FIND_FAILED: ${error.message}`);
    return data ? mapRowToSlotOfferClaim(data as SlotOfferClaimRow) : null;
  }

  async tryReclaim(params: {
    conversationId: string;
    expectedOwnerToken: string;
    newOwnerToken: string;
    intendedRoundId: string;
    staleBefore: Date;
    now: Date;
  }): Promise<SlotOfferClaim | null> {
    const { data, error } = await this.client
      .from("slot_offer_claims")
      .update({
        owner_token: params.newOwnerToken,
        intended_round_id: params.intendedRoundId,
        claimed_at: params.now.toISOString(),
        updated_at: params.now.toISOString(),
      })
      .eq("conversation_id", params.conversationId)
      .eq("owner_token", params.expectedOwnerToken)
      .lt("updated_at", params.staleBefore.toISOString())
      .select()
      .maybeSingle();
    if (error) throw new Error(`SUPABASE_SLOT_OFFER_CLAIM_RECLAIM_FAILED: ${error.message}`);
    return data ? mapRowToSlotOfferClaim(data as SlotOfferClaimRow) : null;
  }

  async release(conversationId: string, ownerToken: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("slot_offer_claims")
      .delete()
      .eq("conversation_id", conversationId)
      .eq("owner_token", ownerToken)
      .select()
      .maybeSingle();
    if (error) throw new Error(`SUPABASE_SLOT_OFFER_CLAIM_RELEASE_FAILED: ${error.message}`);
    return data !== null;
  }
}
