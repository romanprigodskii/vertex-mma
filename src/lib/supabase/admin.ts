import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client.
 *
 * ONLY for "use server" actions that need admin privileges — auth.admin
 * methods (deleteUser, listUsers), bypassing RLS on storage, etc. The
 * service-role key MUST stay server-side; never import this module from
 * client components or route handlers that echo the client back.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Missing Supabase admin credentials.");
  }
  return createSupabaseClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
