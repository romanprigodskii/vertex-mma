import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { FightCardForm } from "@/components/cards/fight-card-form";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getFightCardBySlug } from "@/lib/fight-cards";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string; locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "cards" });
  return { title: t("editMetaTitle") };
}

interface PageProps {
  params: Promise<{ slug: string; locale: string }>;
}

export default async function EditCardPage({ params }: PageProps) {
  const { slug, locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("cards");
  const localePrefix = locale === "en" ? "" : `/${locale}`;
  const [card, user] = await Promise.all([
    getFightCardBySlug(slug),
    getCurrentUser(),
  ]);
  if (!card) notFound();
  if (!user) redirect(`${localePrefix}/signin?next=/cards/${slug}/edit`);
  if (user.userProfileId !== card.user_id) {
    redirect(`${localePrefix}/cards/${slug}`);
  }

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href={`/cards/${card.slug}`}
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> {t("backToCard")}
            </Link>
          </Container>
        </div>

        <Container size="lg" className="py-10 md:py-14">
          <header className="mb-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              {t("editKicker")}
            </p>
            <h1 className="mt-2 font-display text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
              {card.title}
            </h1>
            <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
              {t("editLead")}
            </p>
          </header>
          <FightCardForm
            mode="edit"
            cardId={card.id}
            initialTitle={card.title}
            initialSubtitle={card.subtitle ?? ""}
            initialThemeColor={card.theme_color}
            initialTitleFont={card.title_font}
            initialBackgroundId={card.background_id}
            initialIsPublic={card.is_public}
            initialBouts={card.bouts.map((b) => ({
              fighterA: b.fighter_a
                ? {
                    id: b.fighter_a.id,
                    name: b.fighter_a.name,
                    photo_thumbnail_url: b.fighter_a.photo_thumbnail_url,
                  }
                : null,
              fighterB: b.fighter_b
                ? {
                    id: b.fighter_b.id,
                    name: b.fighter_b.name,
                    photo_thumbnail_url: b.fighter_b.photo_thumbnail_url,
                  }
                : null,
              weightClass: b.weight_class,
              isMain: b.is_main,
            }))}
          />
        </Container>
      </main>
      <Footer />
    </>
  );
}
