import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";

// /me is a thin shortcut to the signed-in user's public profile. The
// canonical view lives at /profile/[username] and renders an Edit button
// for the owner; we don't need a second copy.
export const dynamic = "force-dynamic";

export default async function MePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/me");
  redirect(`/profile/${user.username}`);
}
