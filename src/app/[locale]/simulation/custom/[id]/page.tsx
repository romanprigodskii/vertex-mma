import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Loader2 } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { CustomSimPoller } from "@/components/simulation/custom-sim-poller";
import { CustomSimResultPanel } from "@/components/simulation/custom-sim-result";
import { Link } from "@/i18n/navigation";
import { getCustomSimulation } from "@/lib/custom-simulation";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}): Promise<Metadata> {
  const { locale, id } = await params;
  const t = await getTranslations({ locale, namespace: "customSim" });
  const sim = await getCustomSimulation(id);
  if (!sim) return { title: t("metaTitle") };
  return {
    title: `${sim.fighter_a_name} vs ${sim.fighter_b_name} — ${t("metaTitle")}`,
  };
}

export default async function CustomSimulationResultPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("customSim");
  const sim = await getCustomSimulation(id);
  if (!sim) notFound();

  // The pending row may be older than the poller's patience window —
  // treat anything past ~5 minutes as stalled (worker offline).
  const ageMs = Date.now() - new Date(sim.requested_at).getTime();
  const stalled = sim.status === "pending" && ageMs > 5 * 60 * 1000;

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="lg" className="py-10 md:py-14">
          <CustomSimPoller status={stalled ? "stalled" : sim.status} />
          <header className="mb-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              {t("kicker")}
            </p>
            <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h2">
              {sim.fighter_a_name}{" "}
              <span className="text-foreground-subtle">vs</span>{" "}
              {sim.fighter_b_name}
            </h1>
          </header>

          {sim.status === "done" && sim.result ? (
            <CustomSimResultPanel
              result={sim.result}
              modelVersion={sim.model_version}
            />
          ) : sim.status === "failed" ? (
            <div className="rounded-lg border border-danger/30 bg-danger/5 px-6 py-10 text-center">
              <p className="font-display text-xl uppercase tracking-tight text-foreground">
                {t("failedTitle")}
              </p>
              <p className="mx-auto mt-2 max-w-md font-sans text-sm text-foreground-muted">
                {t("failedLead")}
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-foreground/10 bg-background-elevated/30 px-6 py-14 text-center">
              <Loader2
                className="mx-auto h-6 w-6 animate-spin text-primary"
                aria-hidden
              />
              <p className="mt-4 font-display text-xl uppercase tracking-tight text-foreground">
                {stalled ? t("stalledTitle") : t("pendingTitle")}
              </p>
              <p className="mx-auto mt-2 max-w-md font-sans text-sm text-foreground-muted">
                {stalled ? t("stalledLead") : t("pendingLead")}
              </p>
            </div>
          )}

          <p className="mt-8">
            <Link
              href="/simulation/custom"
              prefetch={false}
              className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle transition-colors hover:text-foreground"
            >
              ← {t("backToBuilder")}
            </Link>
          </p>
        </Container>
      </main>
      <Footer />
    </>
  );
}
