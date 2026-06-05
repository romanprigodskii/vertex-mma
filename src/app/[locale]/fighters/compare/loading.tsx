import { getTranslations } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level fallback for the compare results page. The page itself is
 * force-dynamic and runs ~8 sequential DB queries, so without this Next would
 * show no feedback during the navigation. Mirrors the real layout: back bar,
 * kicker + heading, the cinematic hero band, then the first stat sections.
 */
export default async function CompareLoading() {
  const t = await getTranslations("compare");
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <span className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted">
              <ChevronLeft className="h-4 w-4" aria-hidden />
              {t("backToRoster")}
            </span>
          </Container>
        </div>

        <section className="pt-6 md:pt-8">
          <Container size="xl" className="mb-8 md:mb-12">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              {t("kicker")}
            </p>
            <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
              {t("heading")}
            </h1>
            <p className="mt-3 font-sans text-sm text-foreground-muted">
              {t("loadingComparison")}
            </p>
          </Container>

          {/* Hero band placeholder — matches CompareHero height */}
          <Skeleton className="h-[260px] w-full rounded-none sm:h-[520px] md:h-[600px]" />
        </section>

        {/* First couple of stat sections */}
        {Array.from({ length: 2 }).map((_, i) => (
          <section key={i} className="mt-4 sm:mt-8">
            <Container size="xl">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="mt-2 h-3 w-72 max-w-full" />
              <div className="mt-6 space-y-4">
                {Array.from({ length: 5 }).map((_, r) => (
                  <Skeleton key={r} className="h-10 w-full" />
                ))}
              </div>
            </Container>
          </section>
        ))}
      </main>
      <Footer />
    </>
  );
}
