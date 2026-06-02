"use server";

import { getTranslations } from "next-intl/server";

import { mapAuthError } from "@/lib/auth-errors";
import { createClient } from "@/lib/supabase/server";

export async function signInAction(
  formData: FormData,
): Promise<{ error?: string }> {
  const t = await getTranslations("auth");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: t("errFieldsRequired") };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: mapAuthError(error, t) };
  return {};
}
