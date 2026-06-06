import { getLocale, getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import { Container } from "@/components/layout/container";
import { getCountryFlag } from "@/lib/fighter-helpers";
import type { RankingDetail } from "@/lib/rankings";

interface Props {
  ranking: RankingDetail;
}

/** Localized country name via the runtime's Intl data (mirrors PhysicalInfo). */
function countryName(code: string | null, locale: string): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export async function RankingView({ ranking }: Props) {
  const locale = await getLocale();
  const t = await getTranslations("rankings");
  const tWeight = await getTranslations("weight");
  const date = new Date(ranking.created_at);
  const dateLabel = date.toLocaleDateString(
    locale === "ru" ? "ru-RU" : "en-US",
    {
      month: "long",
      day: "numeric",
      year: "numeric",
    },
  );
  // Grapheme-safe initials: spread splits on code points, not UTF-16 units, so
  // a leading emoji/CJK username doesn't get sliced mid-character.
  const authorInitials = [...ranking.author_username]
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <>
      <section className="border-b border-foreground/[0.06]">
        <Container size="lg" className="py-10 md:py-14">
          <p className="font-display text-xs uppercase tracking-[0.3em] text-primary">
            VERTEX&nbsp;MMA · {t("viewKicker")}
          </p>
          <h1
            className="mt-3 break-words font-display uppercase tracking-tight text-foreground leading-[0.95] line-clamp-3"
            style={{ fontSize: "clamp(36px, 5vw, 64px)" }}
          >
            {ranking.title}
          </h1>
          {ranking.description ? (
            <p className="mt-4 max-w-2xl font-sans text-base text-foreground-muted whitespace-pre-line">
              {ranking.description}
            </p>
          ) : null}
          <p className="mt-5 flex flex-wrap items-center gap-2 font-sans text-sm text-foreground-muted">
            {ranking.author_avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={ranking.author_avatar_url}
                alt={ranking.author_username}
                className="h-6 w-6 rounded-full border border-foreground/15 object-cover"
              />
            ) : (
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 font-display text-[10px] uppercase text-primary">
                {authorInitials}
              </span>
            )}
            <span>
              {t("by")}{" "}
              <Link
                href={`/profile/${ranking.author_username}`}
                className="text-foreground hover:text-primary"
              >
                @{ranking.author_username}
              </Link>{" "}
              · <span className="text-foreground-subtle">{dateLabel}</span> ·{" "}
              <span className="text-foreground-subtle">
                {t("fighterCount", { count: ranking.entry_count })}
              </span>
            </span>
          </p>
        </Container>
      </section>

      <section className="py-10 md:py-14">
        <Container size="lg">
          <ol className="flex flex-col gap-3">
            {ranking.entries.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/fighters/${e.fighter_slug}`}
                  prefetch={false}
                  className="flex items-start gap-4 rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-3 transition-colors hover:bg-foreground/[0.04]"
                >
                  <span className="min-w-[2.5rem] text-center font-display text-3xl tabular text-foreground-subtle">
                    #{e.position}
                  </span>
                  {e.fighter_photo_thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={e.fighter_photo_thumbnail_url}
                      alt={e.fighter_name}
                      className="h-14 w-14 shrink-0 rounded-sm border border-foreground/15 object-cover"
                    />
                  ) : (
                    <div
                      className="h-14 w-14 shrink-0 rounded-sm border border-foreground/15 bg-foreground/[0.05]"
                      aria-hidden
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-display text-lg uppercase tracking-tight text-foreground">
                      {e.fighter_name}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
                      {(() => {
                        if (!e.fighter_weight_class) return "—";
                        const key = e.fighter_weight_class.replace(/-/g, "_");
                        return tWeight.has(key)
                          ? tWeight(key as "lightweight")
                          : e.fighter_weight_class;
                      })()}
                      {e.fighter_country_code ? (
                        <>
                          {" · "}
                          <span aria-hidden>
                            {getCountryFlag(e.fighter_country_code)}
                          </span>{" "}
                          {countryName(e.fighter_country_code, locale) ??
                            e.fighter_country_code}
                        </>
                      ) : null}
                    </p>
                    {e.note ? (
                      <p className="mt-2 font-sans text-sm text-foreground-muted whitespace-pre-line">
                        {e.note}
                      </p>
                    ) : null}
                  </div>
                </Link>
              </li>
            ))}
          </ol>
        </Container>
      </section>
    </>
  );
}
