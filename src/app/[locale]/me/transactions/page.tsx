import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listTransactionsForUser } from "@/lib/transactions";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "transactions" });
  return { title: t("metaTitle") };
}

const KNOWN_TYPES = new Set([
  "signup_bonus",
  "daily_bonus",
  "bet_placed",
  "bet_won",
  "bet_refunded",
  "achievement",
  "admin_adjustment",
]);

export default async function TransactionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("transactions");
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/me/transactions");

  const rows = await listTransactionsForUser(user.userProfileId, 200);
  const dateLocale = locale === "ru" ? "ru-RU" : "en-US";

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href={`/profile/${user.username}`}
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> {t("back")}
            </Link>
          </Container>
        </div>

        <Container size="md" className="py-10 md:py-14">
          <h1 className="font-display uppercase tracking-tight text-foreground text-h1">
            {t("heading")}
          </h1>
          <p className="mt-2 font-sans text-sm text-foreground-muted">
            {t("lead", { balance: user.balanceCoins.toLocaleString(dateLocale) })}
          </p>

          {rows.length === 0 ? (
            <p className="mt-8 rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-12 text-center font-sans text-sm text-foreground-muted">
              {t("empty")}
            </p>
          ) : (
            <ul className="mt-8 flex flex-col gap-1">
              {rows.map((r) => {
                const label = KNOWN_TYPES.has(r.type)
                  ? t(`type_${r.type}`)
                  : r.type;
                const positive = r.amount > 0;
                return (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-foreground/10 bg-background-elevated/30 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-sans text-sm text-foreground">
                        {label}
                      </p>
                      <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                        {new Date(r.createdAt).toLocaleString(dateLocale, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                        {/* The localized type label already conveys the event.
                            r.description is raw English (often a bare UUID), so
                            it must not reach the RU ledger — keep it only as a
                            fallback for any unmapped type. */}
                        {!KNOWN_TYPES.has(r.type) && r.description
                          ? ` · ${r.description}`
                          : ""}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p
                        className={
                          positive
                            ? "font-display text-lg tabular text-streak-win"
                            : "font-display text-lg tabular text-foreground"
                        }
                      >
                        {positive ? "+" : ""}
                        {r.amount.toLocaleString(dateLocale)}
                      </p>
                      <p className="font-mono text-[10px] tabular text-foreground-subtle">
                        {t("balanceAfter", {
                          balance: r.balanceAfter.toLocaleString(dateLocale),
                        })}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}
