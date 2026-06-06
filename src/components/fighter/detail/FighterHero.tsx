import Image from "next/image";
import { getLocale, getTranslations } from "next-intl/server";

import { BmfBadge } from "@/components/fighter/detail/BmfBadge";
import { TrophyBadge } from "@/components/fighter/detail/TrophyBadge";
import { type ChampionEntry } from "@/lib/champions";
import type { FighterDetail } from "@/lib/fighter-detail";
import { getCountryFlag } from "@/lib/fighter-helpers";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

function computeAge(dob: string | null): number | null {
  if (!dob) return null;
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age -= 1;
  return age;
}

// Locale-aware country name (e.g. "United States" / "США") — same approach as
// PhysicalInfo, so the hero tier line matches it instead of showing a bare
// ISO code that reads like a placeholder.
function countryName(code: string | null, locale: string): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

// NOTE: byte-for-byte mirror of FighterAvatar's PALETTE / getColorForName /
// getInitials. Kept in sync by hand for now — FighterAvatar (owned elsewhere)
// is the canonical source; fold into one shared util when both can move together.
const HERO_PALETTE: readonly string[] = [
  "oklch(0.35 0.12 27)",
  "oklch(0.35 0.10 70)",
  "oklch(0.30 0.08 250)",
  "oklch(0.30 0.10 310)",
  "oklch(0.30 0.10 150)",
  "oklch(0.25 0.02 240)",
];

function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h + name.charCodeAt(i)) | 0;
  return HERO_PALETTE[Math.abs(h) % HERO_PALETTE.length];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function HeroPhoto({
  name,
  photoUrl,
}: {
  name: string;
  photoUrl: string | null;
}) {
  const wrapper = cn(
    "relative mx-auto aspect-[3/4] w-full max-w-[280px] overflow-hidden rounded-md",
    "sm:max-w-[320px]",
    "lg:mx-0 lg:aspect-auto lg:h-[480px] lg:w-[360px] lg:max-w-none",
  );
  if (photoUrl) {
    return (
      <div className={wrapper}>
        <Image
          src={photoUrl}
          alt={name}
          fill
          sizes="(min-width: 1024px) 360px, 100vw"
          priority
          className="object-cover object-top brightness-[0.95]"
        />
      </div>
    );
  }
  return (
    <div
      className={cn(wrapper, "border border-foreground/10")}
      style={{ backgroundColor: hashColor(name) }}
    >
      <span
        className="absolute inset-0 flex items-center justify-center font-display uppercase tracking-wider text-foreground/90"
        style={{ fontSize: "clamp(80px, 14vw, 156px)" }}
        aria-hidden
      >
        {initialsOf(name)}
      </span>
    </div>
  );
}

interface FighterHeroProps {
  fighter: FighterDetail;
  championEntry: ChampionEntry | null;
}

export async function FighterHero({ fighter, championEntry }: FighterHeroProps) {
  const tFighter = await getTranslations("fighter");
  const tWeight = await getTranslations("weight");
  const locale = await getLocale();
  const age = computeAge(fighter.dob);
  const flag = getCountryFlag(fighter.country_code);
  const countryLabel = countryName(fighter.country_code, locale);
  const weightLabel = fighter.weight_class_primary
    ? tWeight.has(fighter.weight_class_primary)
      ? tWeight(fighter.weight_class_primary)
      : fighter.weight_class_primary
    : null;
  const statusLabel =
    fighter.status && tFighter.has(`status.${fighter.status}`)
      ? tFighter(`status.${fighter.status}`)
      : null;

  const wins = fighter.wins_total;
  const losses = fighter.losses_total;
  const draws = fighter.draws_total;
  const ncs = fighter.no_contests;
  // Compact hyphen form, matching the metadata title (page.tsx) so the on-page
  // hero and the SEO record read the same; nowrap keeps it on one line.
  const record =
    draws > 0 ? `${wins}-${losses}-${draws}` : `${wins}-${losses}`;
  const denom = wins + losses;
  const winRate =
    denom > 0
      ? tFighter("winRate", { pct: Math.round((wins / denom) * 100) })
      : draws > 0 || ncs > 0
        ? tFighter("noDecisiveResults")
        : tFighter("recordPending");

  const tierBits: string[] = [];
  if (fighter.country_code) tierBits.push(fighter.country_code);
  if (weightLabel) tierBits.push(weightLabel);
  if (statusLabel) tierBits.push(statusLabel);
  if (age != null) tierBits.push(tFighter("age", { n: age }));

  return (
    <section className="border-b border-foreground/10">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-6 px-4 py-8 sm:px-6 md:py-10 lg:flex-row lg:gap-10 lg:px-8 lg:py-12">
        {/* Photo column */}
        <div className="relative shrink-0 lg:w-[360px]">
          <HeroPhoto
            name={fighter.name_en}
            photoUrl={fighter.photo_url}
          />
          {championEntry ? (
            <div className="absolute right-2 top-2">
              <TrophyBadge
                divisionShort={championEntry.divisionShort}
                divisionFull={championEntry.division}
                isInterim={championEntry.isInterim ?? false}
              />
            </div>
          ) : null}
          {/* Wave 10A: BMF badge sits below the divisional TrophyBadge.
              Distinct gold pill so it doesn't read as another divisional belt. */}
          <div
            className={
              championEntry ? "absolute right-2 top-14" : "absolute right-2 top-2"
            }
          >
            <BmfBadge slug={fighter.slug} variant="hero" />
          </div>
        </div>

        {/* Identity column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <h1
            className="font-display uppercase tracking-tight text-foreground leading-[0.9] break-words hyphens-auto [overflow-wrap:anywhere]"
            style={{ fontSize: "clamp(48px, 7vw, 120px)" }}
          >
            {fighter.name_en}
          </h1>
          {fighter.nickname ? (
            <p className="mt-2 font-sans italic text-foreground-muted text-lg md:text-2xl break-words [overflow-wrap:anywhere]">
              &ldquo;{fighter.nickname}&rdquo;
            </p>
          ) : null}

          <p className="mt-4 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-sans text-[11px] uppercase tracking-[0.22em] text-foreground-muted md:text-xs">
            {fighter.country_code ? (
              <>
                <span aria-hidden className="text-[14px] leading-none">
                  {flag}
                </span>
                <span>{countryLabel ?? fighter.country_code}</span>
              </>
            ) : null}
            {tierBits.slice(1).map((bit, i) => (
              <span key={`${bit}-${i}`} className="flex items-center gap-1.5">
                <span aria-hidden className="text-foreground-subtle/50">·</span>
                <span>{bit}</span>
              </span>
            ))}
          </p>

          <div className="mt-6 md:mt-8">
            <p
              className="font-display tabular tracking-tight text-foreground leading-none whitespace-nowrap"
              style={{ fontSize: "clamp(56px, 9vw, 96px)" }}
            >
              {record}
            </p>
            <p className="mt-2 font-sans text-sm text-foreground-muted">
              {winRate}
              {ncs > 0 ? (
                <>
                  <span className="mx-1.5 text-foreground-subtle/50">·</span>
                  <span>{tFighter("noContestSuffix", { n: formatNumber(ncs) })}</span>
                </>
              ) : null}
            </p>
            {fighter.current_streak_type ? (
              <p className="mt-1 font-sans text-xs text-foreground-subtle">
                <span
                  className={
                    fighter.current_streak_type === "W"
                      ? "text-streak-win"
                      : "text-streak-loss"
                  }
                >
                  {fighter.current_streak_type}
                  {fighter.current_streak_count}
                </span>{" "}
                {tFighter("streakSuffix")}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
