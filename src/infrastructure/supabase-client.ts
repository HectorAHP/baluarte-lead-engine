import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";

export function createSupabaseClient(): SupabaseClient {
  if (!config.SUPABASE_URL || !config.SUPABASE_SECRET_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set to use Supabase repositories");
  }
  return createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false },
  });
}
