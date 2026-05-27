import { getTranslations } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Link } from "@/i18n/navigation";

export default async function RankingNotFound() {
  const t = await getTranslations("notFound");
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="sm" className="py-16 text-center">
          <p className="font-mono text-xs uppercase tracking-widest text-foreground-subtle">
            {t("code")}
          </p>
          <h1 className="mt-2 font-display text-3xl uppercase tracking-tight text-foreground">
            {t("rankingTitle")}
          </h1>
          <p className="mt-4 font-sans text-sm text-foreground-muted">
            {t("rankingLead")}
          </p>
          <Link
            href="/rankings"
            className="mt-6 inline-flex rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
          >
            {t("backToRankings")}
          </Link>
        </Container>
      </main>
      <Footer />
    </>
  );
}
