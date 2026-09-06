import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client using the service-role key.
 *
 * The service-role key bypasses Row Level Security entirely, so this module
 * must never be imported from a client component. Every write it performs is
 * responsible for its own tenant scoping — there is no `current_merchant_id()`
 * safety net behind it.
 */

let cached: SupabaseClient | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  cached = createClient(url, serviceRoleKey, {
    auth: {
      // No browser session to persist or refresh on the server.
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  return cached;
}
