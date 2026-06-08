"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronLeft, ChevronRight, Trophy } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Link } from "@/i18n/navigation";
import { type ChampionEntry } from "@/lib/champions";
import type { FighterDetail } from "@/lib/fighter-detail";
import { getCountryFlag } from "@/lib/fighter-helpers";
import { cn } from "@/lib/utils";

const PALETTE: readonly string[] = [
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
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Split a fighter name into "first word" + "rest" so the overlay reads as a
 * two-line poster billing. Single-word names render as one line.
 */
function splitName(name: string): { first: string; rest: string | null } {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return { first: name.trim(), rest: null };
  return { first: parts[0], rest: parts.slice(1).join(" ") };
}

// Filter / mask shared by the photo halves and the mobile banner. Slightly
// darker than the catalog treatment so the white overlay text always reads.
const PHOTO_FILTER = "grayscale(20%) brightness(0.72) saturate(1.1)";
// Dual-layer text shadow: tight near-black halo for crisp letterform
// readability + a wider soft drop that lifts text off busy photo regions.
const TEXT_SHADOW =
  "0 2px 4px oklch(0 0 0 / 0.92), 0 4px 16px oklch(0 0 0 / 0.7)";

interface HalfPhotoProps {
  fighter: FighterDetail;
  champion: ChampionEntry | null;
  align: "left" | "right";
}

/** Desktop banner — one photo half with mask-fade toward center and inset
 *  gold glow when the fighter is a current champion. */
function HalfPhoto({ fighter, champion, align }: HalfPhotoProps) {
  const maskImage =
    align === "left"
      ? "linear-gradient(to right, black 0%, black 55%, transparent 100%)"
      : "linear-gradient(to left, black 0%, black 55%, transparent 100%)";
  const insetGlow =
    champion !== null
      ? "inset 0 0 80px 20px oklch(0.78 0.15 70 / 0.30)"
      : undefined;

  return (
    <div
      className="absolute inset-y-0 w-1/2 overflow-hidden"
      style={{
        ...(align === "left" ? { left: 0 } : { right: 0 }),
        boxShadow: insetGlow,
      }}
    >
      {fighter.photo_url ? (
        <Image
          src={fighter.photo_url}
          alt=""
          fill
          sizes="50vw"
          priority
          className="object-cover object-top"
          style={{
            filter: PHOTO_FILTER,
            WebkitMaskImage: maskImage,
            maskImage,
          }}
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center"
          style={{
            backgroundColor: hashColor(fighter.name_en),
            WebkitMaskImage: maskImage,
            maskImage,
          }}
          aria-hidden
        >
          <span
            className="font-display uppercase tracking-wider text-foreground/40"
            style={{ fontSize: 220 }}
          >
            {initialsOf(fighter.name_en)}
          </span>
        </div>
      )}
    </div>
  );
}

interface IdentityProps {
  fighter: FighterDetail;
  champion: ChampionEntry | null;
  align: "left" | "right";
}

function FighterIdentity({ fighter, champion, align }: IdentityProps) {
  const t = useTranslations("compare");
  const tWeight = useTranslations("weight");
  const flag = getCountryFlag(fighter.country_code);
  // A current champion's belt (title) division is authoritative — derive the
  // weight label from it so the identity line never contradicts the
  // "{divisionShort} · Champion" badge above. Otherwise a stale
  // weight_class_primary can read e.g. "Lightweight" beneath a "WW · Champion"
  // badge. The weight namespace is gender-neutral, so a leading "Women's "
  // prefix is stripped to reach the shared key; both the slug form
  // ("light-heavyweight") and the title form ("Light Heavyweight") normalize
  // identically.
  const weightLabel = (() => {
    const source = champion?.division ?? fighter.weight_class_primary;
    if (!source) return null;
    const key = source
      .toLowerCase()
      .replace(/^women['’]s\s+/, "")
      .replace(/[\s-]+/g, "_");
    if (tWeight.has(key)) return tWeight(key as "lightweight");
    return source;
  })();
  const denom = fighter.wins_total + fighter.losses_total;
  const wr = denom > 0 ? Math.round((fighter.wins_total / denom) * 100) : null;
  const record =
    fighter.draws_total > 0
      ? `${fighter.wins_total}—${fighter.losses_total}—${fighter.draws_total}`
      : `${fighter.wins_total}—${fighter.losses_total}`;
  const { first, rest } = splitName(fighter.name_en);
  const isLeft = align === "left";

  return (
    <div
      className={cn(
        "flex max-w-full flex-col gap-2",
        isLeft ? "items-start text-left" : "items-end text-right",
      )}
      style={{ textShadow: TEXT_SHADOW }}
    >
      {champion ? (
        <span
          className="inline-flex items-center gap-1.5 rounded-md border border-primary/45 bg-primary/15 px-2 py-1 font-sans text-[11px] uppercase tracking-[0.2em] text-primary backdrop-blur-sm"
          aria-label={
            champion.isInterim
              ? t("interimChampionAria", { division: champion.division })
              : t("championAria", { division: champion.division })
          }
        >
          <Trophy className="h-3 w-3" aria-hidden />
          {champion.isInterim
            ? t("interimChampionShort", { division: champion.divisionShort })
            : t("champion", { division: champion.divisionShort })}
        </span>
      ) : null}

      <h2
        className="max-w-full overflow-hidden break-words hyphens-auto font-display uppercase leading-[0.85] tracking-tight text-foreground"
        style={{ fontSize: "clamp(40px, 6.5vw, 88px)" }}
      >
        <span className="block break-words">{first}</span>
        {rest ? <span className="block break-words">{rest}</span> : null}
      </h2>

      {fighter.nickname ? (
        <p className="max-w-[26ch] truncate font-sans text-base italic leading-snug text-foreground-muted md:text-lg">
          &ldquo;{fighter.nickname}&rdquo;
        </p>
      ) : null}

      <p className="flex items-center gap-2 font-sans text-sm uppercase leading-snug tracking-[0.22em] text-foreground-muted">
        <span aria-hidden className="text-base leading-none">
          {flag}
        </span>
        {fighter.country_code ? <span>{fighter.country_code}</span> : null}
        {weightLabel ? (
          <>
            <span aria-hidden className="text-foreground-subtle/40">·</span>
            <span>{weightLabel}</span>
          </>
        ) : null}
      </p>

      <div
        className={cn(
          "mt-1 flex items-baseline gap-3",
          isLeft ? "" : "flex-row-reverse",
        )}
      >
        <span
          className="font-display tabular leading-none tracking-tight text-foreground"
          style={{ fontSize: "clamp(36px, 4.5vw, 64px)" }}
        >
          {record}
        </span>
        {wr != null ? (
          <span className="font-sans text-sm text-foreground-muted">
            {t("winRate", { n: wr })}
          </span>
        ) : null}
      </div>

      <Link
        href={`/fighters/${fighter.slug}`}
        prefetch={false}
        className="mt-2 inline-flex items-center gap-1.5 font-sans text-sm uppercase tracking-widest text-foreground transition-colors hover:text-primary"
      >
        {isLeft ? (
          <>
            {t("viewProfile")}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </>
        ) : (
          <>
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            {t("viewProfile")}
          </>
        )}
      </Link>
    </div>
  );
}

function VsBlock() {
  const t = useTranslations("compare");
  return (
    <span
      aria-hidden
      className="font-display uppercase tracking-[0.05em] text-primary"
      style={{
        fontSize: "clamp(96px, 14vw, 200px)",
        lineHeight: 1,
        textShadow:
          "0 0 28px oklch(0.78 0.15 70 / 0.55), 0 6px 18px oklch(0 0 0 / 0.85)",
      }}
    >
      {t("vsBig")}
    </span>
  );
}

/** Mobile-only — one photo as a 240px tall banner with identity overlaid. */
function MobileBanner({
  fighter,
  champion,
  align,
}: {
  fighter: FighterDetail;
  champion: ChampionEntry | null;
  align: "left" | "right";
}) {
  const t = useTranslations("compare");
  const insetGlow =
    champion !== null
      ? "inset 0 0 60px 16px oklch(0.78 0.15 70 / 0.28)"
      : undefined;
  return (
    <div
      className="relative h-[260px] w-full overflow-hidden rounded-md"
      style={{ boxShadow: insetGlow }}
    >
      {fighter.photo_url ? (
        <Image
          src={fighter.photo_url}
          alt=""
          fill
          sizes="100vw"
          priority
          className="object-cover object-top"
          style={{ filter: PHOTO_FILTER }}
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center"
          style={{ backgroundColor: hashColor(fighter.name_en) }}
          aria-hidden
        >
          <span
            className="font-display uppercase tracking-wider text-foreground/40"
            style={{ fontSize: 140 }}
          >
            {initialsOf(fighter.name_en)}
          </span>
        </div>
      )}
      {/* Bottom-to-top dark gradient for legibility of overlay text */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(to top, oklch(0.08 0.005 240 / 0.95) 0%, oklch(0.08 0.005 240 / 0.4) 45%, transparent 80%)",
        }}
      />
      <div
        className={cn(
          "absolute inset-x-4 bottom-3 flex flex-col gap-1",
          align === "left" ? "items-start text-left" : "items-end text-right",
        )}
        style={{ textShadow: TEXT_SHADOW }}
      >
        {champion ? (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-primary/45 bg-primary/15 px-1.5 py-0.5 font-sans text-[9px] uppercase tracking-[0.2em] text-primary backdrop-blur-sm"
            aria-label={
              champion.isInterim
                ? t("interimChampionAria", { division: champion.division })
                : t("championAria", { division: champion.division })
            }
          >
            <Trophy className="h-2.5 w-2.5" aria-hidden />
            {champion.isInterim
              ? t("interimChampionShort", { division: champion.divisionShort })
              : t("champion", { division: champion.divisionShort })}
          </span>
        ) : null}
        <p
          className="max-w-full break-words hyphens-auto font-display uppercase leading-[0.9] tracking-tight text-foreground"
          style={{ fontSize: 30 }}
        >
          {fighter.name_en}
        </p>
        <p className="font-display tabular text-3xl leading-none text-foreground">
          {fighter.draws_total > 0
            ? `${fighter.wins_total}—${fighter.losses_total}—${fighter.draws_total}`
            : `${fighter.wins_total}—${fighter.losses_total}`}
        </p>
      </div>
    </div>
  );
}

interface CompareHeroProps {
  a: FighterDetail;
  b: FighterDetail;
  championA: ChampionEntry | null;
  championB: ChampionEntry | null;
}

export function CompareHero({ a, b, championA, championB }: CompareHeroProps) {
  const t = useTranslations("compare");
  const reduced = useReducedMotion();
  const photoIn = reduced
    ? { opacity: 1 }
    : { opacity: 0 };
  const leftTextIn = reduced
    ? { opacity: 1, x: 0 }
    : { opacity: 0, x: -20 };
  const rightTextIn = reduced
    ? { opacity: 1, x: 0 }
    : { opacity: 0, x: 20 };
  const vsIn = reduced
    ? { opacity: 1, scale: 1 }
    : { opacity: 0, scale: 0.6 };

  return (
    <>
      {/* ============================================================
          Desktop / tablet — single cinematic banner */}
      <section
        aria-label={t("heroAria", { a: a.name_en, b: b.name_en })}
        className="relative hidden h-[520px] w-full overflow-hidden sm:block md:h-[600px]"
      >
        <motion.div
          initial={photoIn}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
          className="absolute inset-0"
        >
          <HalfPhoto fighter={a} champion={championA} align="left" />
          <HalfPhoto fighter={b} champion={championB} align="right" />
        </motion.div>

        {/* Localized darkening under each identity column. Radial ellipses
            sit roughly where the text overlay lives (20% / 80% of the banner
            width) so faces remain visible at center while names + record
            never compete with photo content. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-2/3"
          style={{
            background:
              "radial-gradient(ellipse 60% 80% at 20% 50%, oklch(0 0 0 / 0.65) 0%, transparent 100%)",
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-2/3"
          style={{
            background:
              "radial-gradient(ellipse 60% 80% at 80% 50%, oklch(0 0 0 / 0.65) 0%, transparent 100%)",
          }}
        />

        {/* Center vertical fade — solidifies the VS strip and absorbs both
            photo edges so the seam between them never reads as a hard line. */}
        <div
          className="pointer-events-none absolute inset-y-0 left-1/2 w-[28%] -translate-x-1/2"
          style={{
            background:
              "linear-gradient(to right, transparent 0%, oklch(0.08 0.005 240 / 0.85) 35%, oklch(0.08 0.005 240) 50%, oklch(0.08 0.005 240 / 0.85) 65%, transparent 100%)",
          }}
        />

        {/* Top + bottom letterbox fades — top keeps banner under the H1 from
            feeling like a hard band; bottom merges into Tale of the Tape. */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-20"
          style={{
            background:
              "linear-gradient(to bottom, var(--color-background-base) 0%, transparent 100%)",
          }}
        />
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-28"
          style={{
            background:
              "linear-gradient(to top, var(--color-background-base) 0%, transparent 100%)",
          }}
        />

        {/* Content overlay — photos run edge-to-edge for the cinematic feel,
            but the identity text + VS respect the same xl Container bounds
            as the rest of the page so nothing clips at viewport edges. */}
        <div className="absolute inset-0">
          <Container size="xl" className="flex h-full items-center">
            <div className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 md:gap-8">
              <motion.div
                initial={leftTextIn}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.5, delay: 0.15, ease: "easeOut" }}
                className="min-w-0"
              >
                <FighterIdentity fighter={a} champion={championA} align="left" />
              </motion.div>

              <motion.div
                initial={vsIn}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.4, delay: 0.25, ease: "easeOut" }}
                className="flex shrink-0 items-center justify-center px-2"
              >
                <VsBlock />
              </motion.div>

              <motion.div
                initial={rightTextIn}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.5, delay: 0.15, ease: "easeOut" }}
                className="flex min-w-0 justify-end"
              >
                <FighterIdentity fighter={b} champion={championB} align="right" />
              </motion.div>
            </div>
          </Container>
        </div>
      </section>

      {/* ============================================================
          Mobile — stacked photo banners with VS sandwiched between */}
      <section
        aria-label={t("heroAria", { a: a.name_en, b: b.name_en })}
        className="flex flex-col items-center gap-3 px-4 sm:hidden"
      >
        <MobileBanner fighter={a} champion={championA} align="left" />
        <span
          aria-hidden
          className="font-display uppercase tracking-[0.05em] text-primary"
          style={{
            fontSize: 64,
            lineHeight: 1,
            textShadow:
              "0 0 18px oklch(0.78 0.15 70 / 0.55), 0 4px 12px oklch(0 0 0 / 0.85)",
          }}
        >
          {t("vsBig")}
        </span>
        <MobileBanner fighter={b} champion={championB} align="right" />
      </section>
    </>
  );
}
