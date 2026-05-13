import Image from "next/image";

import { TrophyBadge } from "@/components/fighter/detail/TrophyBadge";
import { type ChampionEntry } from "@/lib/champions";
import type { FighterDetail } from "@/lib/fighter-detail";
import { getCountryFlag } from "@/lib/fighter-helpers";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  retired: "Retired",
  inactive: "Inactive",
  suspended: "Suspended",
};

const WEIGHT_LABEL: Record<string, string> = {
  strawweight: "Strawweight",
  flyweight: "Flyweight",
  bantamweight: "Bantamweight",
  featherweight: "Featherweight",
  lightweight: "Lightweight",
  welterweight: "Welterweight",
  middleweight: "Middleweight",
  light_heavyweight: "Light Heavyweight",
  heavyweight: "Heavyweight",
  catchweight: "Catchweight",
  openweight: "Openweight",
};

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
  isChampion,
}: {
  name: string;
  photoUrl: string | null;
  isChampion: boolean;
}) {
  const wrapper = cn(
    "relative aspect-[3/4] w-full overflow-hidden rounded-md",
    "lg:aspect-auto lg:h-[480px] lg:w-[360px]",
    isChampion
      ? "border-2 border-primary/40 shadow-glow-primary"
      : "border border-foreground/10",
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
    <div className={wrapper} style={{ backgroundColor: hashColor(name) }}>
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

export function FighterHero({ fighter, championEntry }: FighterHeroProps) {
  const age = computeAge(fighter.dob);
  const flag = getCountryFlag(fighter.country_code);
  const weightLabel = fighter.weight_class_primary
    ? WEIGHT_LABEL[fighter.weight_class_primary] ?? fighter.weight_class_primary
    : null;
  const statusLabel = fighter.status ? STATUS_LABEL[fighter.status] : null;
  const isChampion = championEntry !== null;

  const wins = fighter.wins_total;
  const losses = fighter.losses_total;
  const draws = fighter.draws_total;
  const ncs = fighter.no_contests;
  const record = draws > 0 ? `${wins} — ${losses} — ${draws}` : `${wins} — ${losses}`;
  const denom = wins + losses;
  const winRate = denom > 0 ? `${Math.round((wins / denom) * 100)}% win rate` : "Record pending";

  const tierBits: string[] = [];
  if (fighter.country_code) tierBits.push(fighter.country_code);
  if (weightLabel) tierBits.push(weightLabel);
  if (statusLabel) tierBits.push(statusLabel);
  if (age != null) tierBits.push(`age ${age}`);

  return (
    <section className="border-b border-foreground/10">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-8 px-4 py-10 sm:px-6 md:py-14 lg:flex-row lg:gap-12 lg:px-8 lg:py-16">
        {/* Photo column */}
        <div className="relative shrink-0 lg:w-[360px]">
          <HeroPhoto
            name={fighter.name_en}
            photoUrl={fighter.photo_url}
            isChampion={isChampion}
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
        </div>

        {/* Identity column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <h1
            className="font-display uppercase tracking-tight text-foreground leading-[0.9]"
            style={{ fontSize: "clamp(48px, 7vw, 120px)" }}
          >
            {fighter.name_en}
          </h1>
          {fighter.nickname ? (
            <p className="mt-2 font-sans italic text-foreground-muted text-lg md:text-2xl">
              &ldquo;{fighter.nickname}&rdquo;
            </p>
          ) : null}

          <p className="mt-6 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-sans text-[11px] uppercase tracking-[0.22em] text-foreground-muted md:text-xs">
            {fighter.country_code ? (
              <>
                <span aria-hidden className="text-[14px] leading-none">
                  {flag}
                </span>
                <span>{fighter.country_code}</span>
              </>
            ) : null}
            {tierBits.slice(1).map((bit, i) => (
              <span key={`${bit}-${i}`} className="flex items-center gap-1.5">
                <span aria-hidden className="text-foreground-subtle/50">·</span>
                <span>{bit}</span>
              </span>
            ))}
          </p>

          <div className="mt-10 md:mt-12">
            <p
              className="font-display tabular tracking-tight text-foreground leading-none"
              style={{ fontSize: "clamp(56px, 9vw, 96px)" }}
            >
              {record}
            </p>
            <p className="mt-2 font-sans text-sm text-foreground-muted">
              {winRate}
              {ncs > 0 ? (
                <>
                  <span className="mx-1.5 text-foreground-subtle/50">·</span>
                  <span>
                    {formatNumber(ncs)} NC
                  </span>
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
                streak
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
