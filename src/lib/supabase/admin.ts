import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { publicEnv, serverEnv } from "@/lib/env";

/**
 * Service-role Supabase client.
 *
 * ONLY for "use server" actions that need admin privileges — auth.admin
 * methods (deleteUser, listUsers), bypassing RLS on storage, etc. The
 * service-role key MUST stay server-side; never import this module from
 * client components or route handlers that echo the client back.
 */
export function createAdminClient() {
  return createSupabaseClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv().SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
}
