import { redirect } from "@/i18n/navigation";
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
  const user = await getCurrentUser();
  // next-intl's redirect() returns `never` but isn't treated as a control-flow
  // terminator the way next/navigation's is, so `return` it to narrow `user`
  // (and to actually stop execution here).
  if (!user) return redirect({ href: "/signin?next=/me", locale });
  return redirect({ href: `/profile/${user.username}`, locale });
}
