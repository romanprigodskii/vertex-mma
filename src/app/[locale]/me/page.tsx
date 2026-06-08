import { redirect } from "next/navigation";

import { getCurrentUser } from "@/lib/auth";

// /me is a thin shortcut to the signed-in user's public profile. The
// canonical view lives at /profile/[username] and renders an Edit button
// for the owner; we don't need a second copy.
export const dynamic = "force-dynamic";

export default async function MePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const localePrefix = locale === "en" ? "" : `/${locale}`;
  const user = await getCurrentUser();
  if (!user) redirect(`${localePrefix}/signin?next=${localePrefix}/me`);
  redirect(`${localePrefix}/profile/${user.username}`);
}
