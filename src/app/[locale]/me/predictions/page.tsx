import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  getLocale,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listMyPredictions } from "@/lib/predictions";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "me" });
  return { title: t("myPredictionsTitle") };
}

export default async function MyPredictionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("me");
  const tNav = await getTranslations("nav");
  const activeLocale = await getLocale();
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/me/predictions");
  const rows = await listMyPredictions(user.userProfileId);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href="/predictions"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> {tNav("rankings")}
            </Link>
          </Container>
        </div>

        <Container size="lg" className="py-10 md:py-14">
          <h1 className="font-display uppercase tracking-tight text-foreground text-h1">
            {t("myPredictionsTitle")}
          </h1>

          {rows.length === 0 ? (
            <div className="mt-10 rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
              <p className="font-display text-xl uppercase tracking-tight text-foreground break-words sm:text-2xl">
                {t("noPicks")}
              </p>
              <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                {t("noPicksLead")}
              </p>
              <Link
                href="/predictions"
                className="mt-6 inline-block rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                {t("browseOpenEvents")} →
              </Link>
            </div>
          ) : (
            <ul className="mt-8 flex flex-col gap-2">
              {rows.map((r) => (
                <li key={r.prediction_event_id}>
                  <Link
                    href={`/predictions/${r.prediction_event_id}`}
                    prefetch={false}
                    className="block rounded-md border border-foreground/10 bg-background-elevated/30 p-3 hover:bg-foreground/[0.04]"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-sans text-sm text-foreground">
                          {r.event_name}
                        </p>
                        <p className="mt-0.5 font-mono text-[11px] tabular text-foreground-subtle">
                          {new Date(r.event_date).toLocaleDateString(
                            activeLocale === "ru" ? "ru-RU" : "en-US",
                            { month: "short", day: "numeric", year: "numeric" },
                          )}{" "}
                          · {t("picksCount", { count: r.picks_count })}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        {r.status === "resolved" ? (
                          <p className="font-display text-lg tabular text-foreground">
                            {r.correct_count}/{r.picks_count}
                          </p>
                        ) : (
                          <p className="font-mono text-xs text-foreground-subtle">
                            {t("pending")}
                          </p>
                        )}
                        <p className="font-mono text-[10px] tabular text-foreground-subtle">
                          {t("pointsSuffix", { n: r.total_points })}
                        </p>
                      </div>
                    </div>
                  </Link>
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
