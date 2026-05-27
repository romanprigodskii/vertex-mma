import { getTranslations } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Link } from "@/i18n/navigation";

export async function generateMetadata() {
  const t = await getTranslations("notFound");
  return { title: t("metaTitle") };
}

export default async function NotFoundPage() {
  const t = await getTranslations("notFound");
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-20 text-center md:py-32">
          <p className="font-display text-8xl leading-none tabular text-primary">
            {t("code")}
          </p>
          <h1 className="mt-6 font-display text-4xl uppercase tracking-tight text-foreground">
            {t("title")}
          </h1>
          <p className="mx-auto mt-4 max-w-md font-sans text-base text-foreground-muted">
            {t("lead")}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/"
              className="rounded-sm bg-primary px-5 py-2.5 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
            >
              {t("home")}
            </Link>
            <Link
              href="/fighters"
              className="rounded-sm border border-foreground/15 px-5 py-2.5 font-display text-sm uppercase tracking-widest text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
            >
              {t("browseFighters")}
            </Link>
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
