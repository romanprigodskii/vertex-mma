"use server";

import { eq } from "drizzle-orm";
import { headers } from "next/headers";

import { db } from "@/lib/db";
import { userProfile } from "@/lib/db/schema/users";
import { createClient } from "@/lib/supabase/server";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

export async function signUpAction(
  formData: FormData,
): Promise<{ error?: string }> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const username = String(formData.get("username") ?? "").trim();

  if (!email || !password || !username) {
    return { error: "All fields are required." };
  }
  if (!USERNAME_RE.test(username)) {
    return { error: "Username must be 3–30 chars: letters, digits, underscore." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  // Pre-check username uniqueness; the trigger has a final safety net
  // (numeric suffix on collision) but we want to surface a clean error.
  const existing = await db
    .select({ id: userProfile.id })
    .from(userProfile)
    .where(eq(userProfile.username, username))
    .limit(1);
  if (existing.length > 0) {
    return { error: "Username already taken." };
  }

  const supabase = await createClient();

  const h = await headers();
  const origin =
    h.get("origin") ??
    `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { username },
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });
  if (error) return { error: error.message };

  return {};
}
