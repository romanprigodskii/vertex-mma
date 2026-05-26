import type { Metadata } from "next";
import Link from "next/link";
import { Play } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WEIGHT_CLASSES } from "@/lib/constants";
import { abbreviateMethod } from "@/lib/method";
import { listWatchableBouts, type WatchListRow } from "@/lib/watch";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Watch — full UFC fights",
  description:
    "Every UFC bout on Vertex MMA with a linked official Full Fight or Free Fight upload from YouTube.",
};

const WEIGHT_LABEL: Record<string, string> = Object.fromEntries(
  WEIGHT_CLASSES.map((w) => [w.id, w.label]),
);
WEIGHT_LABEL["catchweight"] = "Catchweight";
WEIGHT_LABEL["openweight"] = "Openweight";

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d
    .toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();
}

function formatDuration(seconds: number | null): string | null {
  if (seconds == null) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

export default async function WatchPage() {
  const bouts = await listWatchableBouts();

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <header className="mb-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              UFC · Full fights
            </p>
            <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
              Watch
            </h1>
            <p className="mt-2 max-w-2xl font-sans text-sm text-foreground-muted">
              Every UFC bout with an official Full Fight or Free Fight upload on
              the UFC YouTube channel. {bouts.length} fight
              {bouts.length === 1 ? "" : "s"} on record — newest first.
            </p>
          </header>

          {bouts.length === 0 ? (
            <p className="py-12 text-center font-sans text-sm text-foreground-muted">
              No videos linked yet.
            </p>
          ) : (
            <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {bouts.map((b) => (
                <WatchCard key={b.bout_id} bout={b} />
              ))}
            </ul>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}

function WatchCard({ bout }: { bout: WatchListRow }) {
  const duration = formatDuration(bout.video_duration_seconds);
  const winnerSide =
    bout.winner_id === bout.fighter_a_id
      ? "a"
      : bout.winner_id === bout.fighter_b_id
        ? "b"
        : null;
  const methodLabel = abbreviateMethod(bout.method);
  const weight = WEIGHT_LABEL[bout.weight_class] ?? bout.weight_class;

  return (
    <li>
      <Link
        href={`/bouts/${bout.bout_id}`}
        prefetch={false}
        className="group block overflow-hidden rounded-[12px] border border-foreground/10 bg-background-elevated/40 transition-colors hover:border-foreground/25 hover:bg-background-elevated/70"
      >
        <div className="relative aspect-video overflow-hidden bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={thumbnailUrl(bout.youtube_video_id)}
            alt=""
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            loading="lazy"
          />
          <span className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_transparent_30%,_rgba(0,0,0,0.55)_100%)]" />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="inline-flex h-[52px] w-[52px] items-center justify-center rounded-full bg-[#ff0033]/95 text-white shadow-[0_8px_24px_rgba(0,0,0,0.45)] transition-transform group-hover:scale-110">
              <Play className="h-5 w-5 translate-x-[2px]" fill="currentColor" />
            </span>
          </span>
          <span className="absolute left-2.5 top-2.5 inline-flex items-center rounded-[4px] bg-black/70 px-1.5 py-1 font-mono text-[9px] uppercase tracking-[0.16em] text-white">
            Full fight
          </span>
          {bout.is_title_fight ? (
            <span className="absolute right-2.5 top-2.5 inline-flex items-center rounded-[4px] bg-primary/95 px-1.5 py-1 font-mono text-[9px] uppercase tracking-[0.16em] text-background-base">
              Title
            </span>
          ) : null}
          {duration ? (
            <span className="absolute bottom-2.5 right-2.5 inline-flex items-center rounded-[4px] bg-black/80 px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-white">
              {duration}
            </span>
          ) : null}
          {bout.total_videos > 1 ? (
            <span className="absolute bottom-2.5 left-2.5 inline-flex items-center rounded-[4px] bg-black/80 px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-white">
              +{bout.total_videos - 1} more
            </span>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 p-3.5">
          <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-foreground-subtle">
            {formatDate(bout.event_date)}
            <span className="mx-1.5 text-foreground-subtle/50">·</span>
            {weight}
            {methodLabel ? (
              <>
                <span className="mx-1.5 text-foreground-subtle/50">·</span>
                {methodLabel}
              </>
            ) : null}
          </p>
          <div className="flex items-baseline justify-between gap-2 leading-tight">
            <span
              className={cn(
                "truncate font-display text-base uppercase tracking-tight",
                winnerSide === "a" ? "text-foreground" : "text-foreground-muted",
              )}
              title={bout.fighter_a_name}
            >
              {bout.fighter_a_name}
            </span>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground-subtle">
              vs
            </span>
            <span
              className={cn(
                "truncate text-right font-display text-base uppercase tracking-tight",
                winnerSide === "b" ? "text-foreground" : "text-foreground-muted",
              )}
              title={bout.fighter_b_name}
            >
              {bout.fighter_b_name}
            </span>
          </div>
          <p className="truncate font-sans text-xs text-foreground-muted" title={bout.event_name}>
            {bout.event_short_name || bout.event_name}
          </p>
        </div>
      </Link>
    </li>
  );
}
