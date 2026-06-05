import { getTranslations } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

export default async function EventNotFound() {
  const t = await getTranslations("notFound");
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container
          size="xl"
          className="flex flex-col items-center justify-center gap-6 py-24 text-center md:py-32"
        >
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-foreground-subtle">
            {t("eventKicker")}
          </p>
          <h1
            className="font-display uppercase tracking-tight text-foreground leading-[0.9]"
            style={{ fontSize: "clamp(48px, 7vw, 96px)" }}
          >
            {t("eventTitle")}
          </h1>
          <p className="max-w-md font-sans text-sm text-foreground-muted">
            {t("eventLead")}
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href="/events">
              <ChevronLeft className="h-4 w-4" />
              {t("backToEvents")}
            </Link>
          </Button>
        </Container>
      </main>
      <Footer />
    </>
  );
}
