"use server";

import { headers } from "next/headers";

import { createClient } from "@/lib/supabase/server";

export async function forgotPasswordAction(
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return { error: "Email required." };

  const supabase = await createClient();
  const h = await headers();
  const origin =
    h.get("origin") ??
    `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;

  // Route through the existing /auth/callback handler so the recovery
  // code is exchanged for a session before we land on the reset form.
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/auth/reset-password`,
  });
  if (error) return { error: error.message };
  return { success: true };
}
