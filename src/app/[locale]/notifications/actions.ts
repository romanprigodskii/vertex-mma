"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { userProfile } from "@/lib/db/schema/users";
import { createClient } from "@/lib/supabase/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getMyProfileId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const rows = await db
    .select({ id: userProfile.id })
    .from(userProfile)
    .where(eq(userProfile.authUserId, user.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function markNotificationReadAction(
  notificationId: string,
): Promise<{ error?: string }> {
  if (!UUID_RE.test(notificationId)) {
    return { error: "Invalid notification id." };
  }
  const myId = await getMyProfileId();
  if (!myId) return { error: "Not signed in." };

  await db.execute(sql`
    UPDATE notification
    SET is_read = TRUE
    WHERE id = ${notificationId}::uuid AND user_id = ${myId}::uuid
  `);
  revalidatePath("/notifications");
  return {};
}

export async function markAllReadAction(): Promise<{ error?: string }> {
  const myId = await getMyProfileId();
  if (!myId) return { error: "Not signed in." };

  await db.execute(sql`
    UPDATE notification
    SET is_read = TRUE
    WHERE user_id = ${myId}::uuid AND is_read = FALSE
  `);
  revalidatePath("/notifications");
  return {};
}
