import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { BoutAnchorHighlight } from "@/components/event/BoutAnchorHighlight";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WEIGHT_CLASSES } from "@/lib/constants";
import {
  type EventBout,
  type EventDetail,
  getEventBouts,
  getEventBySlug,
} from "@/lib/event-detail";
import { getCountryFlag } from "@/lib/fighter-helpers";
import { isCuratedTitleFight } from "@/lib/title-fights";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const WEIGHT_LABEL: Record<string, string> = Object.fromEntries(
  WEIGHT_CLASSES.map((w) => [w.id, w.label]),
);
WEIGHT_LABEL["catchweight"] = "Catchweight";
WEIGHT_LABEL["openweight"] = "Openweight";

const METHOD_SHORT: Record<string, string> = {
  ko: "KO",
  tko: "TKO",
  submission: "Sub",
  decision_unanimous: "U-Dec",
  decision_split: "S-Dec",
  decision_majority: "M-Dec",
  draw: "Draw",
  no_contest: "NC",
  dq: "DQ",
};

function formatRoundTime(sec: number | null): string {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatEventDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function locationString(event: EventDetail): string | null {
  const bits: string[] = [];
  if (event.venue) bits.push(event.venue);
  if (event.location_city) bits.push(event.location_city);
  if (bits.length === 0) return null;
  return bits.join(", ");
}

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const event = await getEventBySlug(slug);
  if (!event) return { title: "Event not found" };
  return {
    title: event.short_name || event.name,
    description: `${event.name} fight card and results.`,
    openGraph: {
      title: `${event.short_name || event.name} · Vertex MMA`,
      description: `Fight card and results for ${event.name}.`,
      images: event.poster_url ? [event.poster_url] : [],
    },
  };
}

function BoutCard({ bout }: { bout: EventBout }) {
  const weightLabel = WEIGHT_LABEL[bout.weight_class] ?? bout.weight_class;
  const time = formatRoundTime(bout.time_finished_seconds);
  // Method may be NULL for many completed bouts (scraper gap, Wave 3.5 will
  // backfill). Fall back to "Finish" / "Decision" inferred from how the bout
  // ended, so the bout card never reads just "vs".
  const wentFullDistance =
    bout.round_finished != null &&
    bout.round_finished >= bout.scheduled_rounds &&
    (bout.time_finished_seconds ?? 0) >= 280;
  const inferredFromTime: string | null =
    bout.status === "completed"
      ? wentFullDistance
        ? "Decision"
        : bout.round_finished
          ? "Finish"
          : null
      : null;
  const methodLabel = bout.method
    ? METHOD_SHORT[bout.method] ?? bout.method
    : inferredFromTime;

  const finishDetail =
    bout.status === "completed" && bout.round_finished
      ? `R${bout.round_finished}${time ? ` · ${time}` : ""}`
      : null;

  const placement = bout.is_main_event
    ? "Main event"
    : bout.is_co_main_event
      ? "Co-main"
      : null;

  const winnerId = bout.winner_id;
  const aWon = winnerId === bout.fighter_a.id;
  const bWon = winnerId === bout.fighter_b.id;
  const isDraw =
    bout.status === "completed" && !winnerId && bout.method !== "no_contest";
  const isNc = bout.method === "no_contest";

  return (
    <article
      id={`bout-${bout.id}`}
      className="scroll-mt-24 rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-4"
    >
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
          {placement ? (
            <span className="text-primary">{placement}</span>
          ) : null}
          {placement ? <span className="mx-1.5 text-foreground-subtle/40">·</span> : null}
          <span>{weightLabel}</span>
          <span className="mx-1.5 text-foreground-subtle/40">·</span>
          <span>{bout.scheduled_rounds} rounds</span>
          {isCuratedTitleFight(bout.id) ? (
            <>
              <span className="mx-1.5 text-foreground-subtle/40">·</span>
              <span
                className="rounded-sm border border-primary/35 bg-primary/10 px-1.5 py-0.5 text-primary"
                aria-label="Title fight"
              >
                Title
              </span>
            </>
          ) : null}
        </p>
        {finishDetail ? (
          <p className="font-mono text-[11px] tabular text-foreground-subtle">
            {finishDetail}
          </p>
        ) : null}
      </header>

      <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <FighterSide
          fighter={bout.fighter_a}
          won={aWon}
          isDraw={!!isDraw}
          isNc={isNc}
          align="left"
        />
        <div className="text-center sm:text-center">
          <p className="font-sans font-bold text-lg uppercase tracking-widest text-foreground-subtle">
            vs
          </p>
          {bout.status === "completed" ? (
            <p className="mt-0.5 font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
              {isNc
                ? "No Contest"
                : isDraw
                  ? `Draw${methodLabel ? ` · ${methodLabel}` : ""}`
                  : methodLabel ?? "Result —"}
            </p>
          ) : (
            <p className="mt-0.5 font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
              {bout.status}
            </p>
          )}
          <Link
            href={`/bouts/${bout.id}`}
            prefetch={false}
            className="mt-1 inline-flex font-sans text-[10px] uppercase tracking-widest text-primary/80 hover:text-primary"
          >
            View details
          </Link>
        </div>
        <FighterSide
          fighter={bout.fighter_b}
          won={bWon}
          isDraw={!!isDraw}
          isNc={isNc}
          align="right"
        />
      </div>
    </article>
  );
}

function FighterSide({
  fighter,
  won,
  isDraw,
  isNc,
  align,
}: {
  fighter: EventBout["fighter_a"];
  won: boolean;
  isDraw: boolean;
  isNc: boolean;
  align: "left" | "right";
}) {
  const flag = getCountryFlag(fighter.country_code);
  return (
    <Link
      href={`/fighters/${fighter.slug}`}
      prefetch={false}
      className={cn(
        "group flex flex-col gap-0.5 rounded-sm px-2 py-1 transition-colors",
        "hover:bg-foreground/[0.03]",
        align === "right" ? "sm:text-right sm:items-end" : "sm:items-start",
      )}
    >
      <span
        className={cn(
          "font-sans font-bold text-lg uppercase leading-tight tracking-tight text-foreground sm:text-xl",
          won ? "text-streak-win" : "",
          isNc ? "text-foreground-muted" : "",
          isDraw ? "text-foreground-muted" : "",
        )}
      >
        {fighter.name_en}
      </span>
      {fighter.nickname ? (
        <span className="truncate font-sans text-[12px] italic text-foreground-muted">
          &ldquo;{fighter.nickname}&rdquo;
        </span>
      ) : null}
      <span className="flex items-center gap-1.5 font-sans text-[11px] uppercase tracking-widest text-foreground-subtle sm:justify-end">
        {align === "left" ? (
          <>
            <span aria-hidden className="text-[13px] leading-none">
              {flag}
            </span>
            <span>{fighter.country_code ?? "—"}</span>
            {won ? (
              <span className="text-streak-win">· Winner</span>
            ) : null}
          </>
        ) : (
          <>
            {won ? (
              <span className="text-streak-win">Winner ·</span>
            ) : null}
            <span>{fighter.country_code ?? "—"}</span>
            <span aria-hidden className="text-[13px] leading-none">
              {flag}
            </span>
          </>
        )}
      </span>
    </Link>
  );
}

export default async function EventDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const event = await getEventBySlug(slug);
  if (!event) notFound();

  const bouts = await getEventBouts(event.id);
  const dateStr = formatEventDate(event.date);
  const location = locationString(event);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href="/fighters"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted transition-colors hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              Back
            </Link>
          </Container>
        </div>

        <section className="border-b border-foreground/10">
          <Container size="xl" className="py-10 md:py-12">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              Event · {event.promotion.toUpperCase()}
            </p>
            <h1 className="mt-3 font-sans font-bold uppercase tracking-tight text-foreground text-hero">
              {event.short_name || event.name}
            </h1>
            <p className="mt-4 font-sans text-[11px] uppercase tracking-[0.22em] text-foreground-muted">
              <span className="font-mono tabular text-foreground">{dateStr}</span>
              {location ? (
                <>
                  <span className="mx-2 text-foreground-subtle/50">·</span>
                  <span>{location}</span>
                </>
              ) : null}
            </p>
            <p className="mt-3 font-sans text-xs text-foreground-subtle">
              Full event analytics arrive in a later wave — for now this is a
              fight card view with results.
            </p>
          </Container>
        </section>

        <section className="py-10 md:py-14">
          <Container size="xl">
            <h2 className="mb-5 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              Fight card
            </h2>
            {bouts.length === 0 ? (
              <div className="rounded-md border border-dashed border-foreground/10 bg-background-elevated/30 px-6 py-12 text-center">
                <p className="font-sans text-sm text-foreground-muted">
                  No bouts recorded for this event yet.
                </p>
              </div>
            ) : (
              <>
                <BoutAnchorHighlight />
                <ul className="flex flex-col gap-3">
                  {bouts.map((b) => (
                    <li key={b.id}>
                      <BoutCard bout={b} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Container>
        </section>
      </main>
      <Footer />
    </>
  );
}
