import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { CustomSimBuilder } from "@/components/simulation/custom-sim-builder";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listMyCustomSimulations } from "@/lib/custom-simulation";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "customSim" });
  return { title: t("metaTitle"), description: t("metaDescription") };
}

export default async function CustomSimulationPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("customSim");
  const user = await getCurrentUser();
  const mySims = user
    ? await listMyCustomSimulations(user.userProfileId)
    : [];

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <header className="mb-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              {t("kicker")}
            </p>
            <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
              {t("heading")}
            </h1>
            <p className="mt-2 max-w-2xl font-sans text-sm text-foreground-muted">
              {t("lead")}
            </p>
          </header>

          <CustomSimBuilder isSignedIn={user !== null} />

          {mySims.length > 0 && (
            <section aria-label={t("mySims")} className="mt-10">
              <h2 className="mb-4 font-display text-xl uppercase tracking-tight text-foreground">
                {t("mySims")}
              </h2>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {mySims.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={`/simulation/custom/${s.id}`}
                      prefetch={false}
                      className="flex items-center justify-between gap-3 rounded-md border border-foreground/10 bg-background-elevated/30 px-3 py-2.5 transition-colors hover:bg-foreground/[0.04]"
                    >
                      <span className="min-w-0 truncate font-sans text-sm text-foreground">
                        {s.fighter_a_name} vs {s.fighter_b_name}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-foreground-subtle">
                        {s.status === "done" && s.prob_a != null
                          ? `${Math.round(s.prob_a * 100)}%`
                          : t(
                              s.status === "pending"
                                ? "statusPending"
                                : "statusFailed",
                            )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}
