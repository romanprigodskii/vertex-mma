import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Link, redirect } from "@/i18n/navigation";
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

// Ledger paging: show DEFAULT_LIMIT rows and let `?limit=` widen the window up
// to MAX_LIMIT via a "load more" link, instead of a silent hard cap.
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

function parseLimit(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

export default async function TransactionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ limit?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("transactions");
  // "Load more" reuses catalog's generic pagination string — messages/*.json is
  // owned by another change, and transactions has no loadMore key of its own.
  const tCatalog = await getTranslations("catalog");
  const user = await getCurrentUser();
  // `return` the redirect: next-intl's redirect() returns `never` but isn't
  // treated as a control-flow terminator, so this is needed to narrow `user`.
  if (!user) return redirect({ href: "/signin?next=/me/transactions", locale });

  const limit = parseLimit((await searchParams).limit);
  // Probe one extra row to know whether older history exists without a second
  // COUNT query; render only `limit`, treat the surplus as a "more" flag.
  const fetched = await listTransactionsForUser(user.userProfileId, limit + 1);
  const hasMore = fetched.length > limit && limit < MAX_LIMIT;
  const rows = hasMore ? fetched.slice(0, limit) : fetched;
  const nextLimit = Math.min(limit + DEFAULT_LIMIT, MAX_LIMIT);
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
                        {r.description ? ` · ${r.description}` : ""}
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

          {hasMore ? (
            <div className="mt-6 text-center">
              <Link
                href={`/me/transactions?limit=${nextLimit}`}
                className="inline-block font-sans text-xs uppercase tracking-widest text-primary transition-colors hover:text-primary/80"
              >
                {tCatalog("loadMore")}
              </Link>
            </div>
          ) : null}
        </Container>
      </main>
      <Footer />
    </>
  );
}
