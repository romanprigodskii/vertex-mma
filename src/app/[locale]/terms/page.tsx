import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

// Single source of truth for this document's revision date. Bump it whenever
// the copy below changes — the displayed "Last updated" date is derived from it
// and localized, so it can never silently drift from a hand-edited string.
const LAST_UPDATED = new Date(Date.UTC(2026, 5, 15));

/** Renders a section body as a real <ul> when it's a "• "-prefixed bullet list
 *  (proper list semantics + hanging indents on wrap), otherwise a paragraph. */
function PolicyBody({ body }: { body: string }) {
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const isList = lines.length >= 1 && lines.every((l) => l.startsWith("•"));
  if (isList) {
    return (
      <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5 font-sans text-sm leading-relaxed text-foreground-muted marker:text-foreground-subtle">
        {lines.map((l, i) => (
          <li key={i}>{l.replace(/^•\s*/, "")}</li>
        ))}
      </ul>
    );
  }
  return (
    <p className="mt-2 whitespace-pre-line font-sans text-sm leading-relaxed text-foreground-muted">
      {body}
    </p>
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "static" });
  return { title: t("termsTitle") };
}

export default async function TermsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("static");
  const sections = t.raw("termsSections") as Array<{
    heading: string;
    body: string;
  }>;
  const lastUpdated = LAST_UPDATED.toLocaleDateString(
    locale === "ru" ? "ru-RU" : "en-US",
    { year: "numeric", month: "long", timeZone: "UTC" },
  );
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-16">
          <p className="text-center font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
            {t("brand")}
          </p>
          <h1 className="mt-3 text-center font-display uppercase tracking-tight text-foreground text-h1">
            {t("termsTitle")}
          </h1>
          <p className="mt-3 text-center font-sans text-xs text-foreground-subtle">
            {t("lastUpdatedLabel", { date: lastUpdated })}
          </p>
          <p className="mx-auto mt-8 max-w-2xl font-sans text-sm leading-relaxed text-foreground-muted">
            {t("termsLead")}
          </p>
          <div className="mx-auto mt-10 flex max-w-2xl flex-col gap-8">
            {sections.map((s) => (
              <section key={s.heading}>
                <h2 className="font-display text-lg uppercase tracking-tight text-foreground">
                  {s.heading}
                </h2>
                <PolicyBody body={s.body} />
              </section>
            ))}
          </div>
          <p className="mx-auto mt-10 max-w-2xl border-t border-foreground/10 pt-6 font-sans text-xs leading-relaxed text-foreground-subtle">
            {t("contactBody")}
          </p>
        </Container>
      </main>
      <Footer />
    </>
  );
}
