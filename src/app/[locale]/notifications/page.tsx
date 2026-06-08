import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { MarkAllReadButton } from "@/components/notifications/mark-all-read-button";
import { NotificationRow } from "@/components/notifications/notification-row";
import { getCurrentUser } from "@/lib/auth";
import { listNotifications } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "notifications" });
  return { title: t("metaTitle") };
}

export default async function NotificationsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("notifications");
  const localePrefix = locale === "en" ? "" : `/${locale}`;
  const user = await getCurrentUser();
  if (!user)
    redirect(`${localePrefix}/signin?next=${localePrefix}/notifications`);

  const LIMIT = 100;
  // Fetch one extra to detect (without a second query) whether older
  // notifications exist beyond the cap, then trim to the limit for display.
  const fetched = await listNotifications(user.userProfileId, LIMIT + 1);
  const items = fetched.slice(0, LIMIT);
  const hasMore = fetched.length > LIMIT;
  const hasUnread = items.some((n) => !n.is_read);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-10 md:py-14">
          <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
                {t("kicker")}
              </p>
              <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
                {t("heading")}
              </h1>
            </div>
            {hasUnread ? <MarkAllReadButton /> : null}
          </header>

          {items.length === 0 ? (
            <p className="py-12 text-center font-sans text-sm text-foreground-muted">
              {t("empty")}
            </p>
          ) : (
            <>
              <ul className="flex flex-col rounded-md border border-foreground/10 bg-background-elevated/30">
                {items.map((n) => (
                  <li key={n.id} className="last:[&>*]:border-b-0">
                    <NotificationRow notification={n} />
                  </li>
                ))}
              </ul>
              {hasMore ? (
                <p className="mt-4 text-center font-sans text-xs text-foreground-subtle">
                  {t("truncatedNote", { count: LIMIT })}
                </p>
              ) : null}
            </>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}
