import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { PendingNewsCard } from "@/components/admin/pending-news-card";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { redirect } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getPendingNewsItems } from "@/lib/news-moderation";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin" });
  return { title: t("newsMetaTitle"), robots: { index: false, follow: false } };
}

export default async function AdminNewsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("admin");

  const user = await getCurrentUser();
  if (!user) return redirect({ href: "/signin?next=/admin/news", locale });
  // Hide the route entirely from non-staff rather than disclosing it exists.
  if (!user.isStaff) notFound();

  const items = await getPendingNewsItems(150);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-10 md:py-14">
          <header className="mb-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              {t("kicker")}
            </p>
            <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
              {t("newsHeading")}
            </h1>
            <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
              {t("newsLead", { count: items.length })}
            </p>
          </header>

          {items.length === 0 ? (
            <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
              <p className="font-display text-xl uppercase tracking-tight text-foreground sm:text-2xl">
                {t("queueEmptyTitle")}
              </p>
              <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                {t("queueEmptyLead")}
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {items.map((item) => (
                <li key={item.id}>
                  <PendingNewsCard item={item} />
                </li>
              ))}
            </ul>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}
