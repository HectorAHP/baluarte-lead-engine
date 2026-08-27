-- Conversation status (Phase 8 human handoff / Phase 9 closed state need somewhere to live
-- independent of the lead's own status).
alter table conversations add column if not exists status text not null default 'ACTIVE';

-- Migration 001 created conversations/messages with no supporting indexes at all beyond their
-- primary keys, so ConversationRepository.findActiveByLeadId and
-- MessageRepository.listByConversationId (both added in Phase 1) would otherwise sequential-scan.
create index if not exists conversations_lead_id_status_idx on conversations(lead_id, status);
create index if not exists messages_conversation_id_idx on messages(conversation_id);

-- Inbound WhatsApp message dedup: the provider can redeliver the same webhook payload more
-- than once. provider_message_id is the primary defense; a message without one (e.g. an
-- outbound message we generated ourselves) is naturally excluded from the uniqueness check.
-- Composite (channel, provider_message_id), not provider_message_id alone: a provider's
-- message ID is only guaranteed unique within that provider/channel's own ID space, so once a
-- second channel exists this must not collide across channels.
create unique index if not exists messages_channel_provider_message_id_unique
  on messages(channel, provider_message_id) where provider_message_id is not null;

-- WhatsApp identity dedup: a given WhatsApp user id should map to at most one lead. Placed
-- here (rather than in 006) because it's messaging-channel identity, grouped with the other
-- messaging-dedup index above.
create unique index if not exists leads_whatsapp_user_id_unique
  on leads(whatsapp_user_id) where whatsapp_user_id is not null;
