"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Play } from "lucide-react";

import { Container } from "@/components/layout/container";
import { cn } from "@/lib/utils";

export type BoutVideo = {
  id: string;
  youtube_video_id: string;
  kind: "free_fight" | "highlights";
  title: string;
  duration_seconds: number | null;
  thumbnail_url: string | null;
};

interface BoutVideosProps {
  videos: BoutVideo[];
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Canonical thumbnail URL — mqdefault is a clean 16:9 crop with no letter-
 *  boxing and stays cached forever; the auth-token-bearing URLs yt-dlp
 *  scrapes ("...?sqp=...&rs=...") can rotate or expire. */
function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}

/** Free fights sort before highlights — mirrors the server's kind-first
 *  ordering (bout-detail.ts) so a long highlights clip never floats above a
 *  full fight just because it runs longer. */
function kindRank(kind: BoutVideo["kind"]): number {
  return kind === "free_fight" ? 0 : 1;
}

export function BoutVideos({ videos }: BoutVideosProps) {
  const t = useTranslations("bout");

  // Free fights first, then the longest uploads — the real unedited bout
  // ranks above the short condensed clips regardless of raw duration.
  const sorted = React.useMemo(() => {
    return [...videos].sort(
      (a, b) =>
        kindRank(a.kind) - kindRank(b.kind) ||
        (b.duration_seconds ?? 0) - (a.duration_seconds ?? 0),
    );
  }, [videos]);

  if (videos.length === 0) return null;

  return (
    <section
      aria-label={t("watch")}
      className="border-t border-foreground/10 py-10 md:py-12"
    >
      <Container size="xl">
        <div className="mb-5 flex items-end justify-between gap-4">
          <h2 className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            {t("watch")}
          </h2>
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-foreground-subtle">
            {t("watchSubtitle")}
          </p>
        </div>
        <div
          className={cn(
            "grid gap-5",
            sorted.length === 1
              ? "md:grid-cols-1"
              : "md:grid-cols-2",
          )}
        >
          {sorted.map((v, i) => (
            <VideoCard
              key={v.id}
              video={v}
              priority={i === 0}
              label={v.kind === "free_fight" ? t("fullFight") : t("highlights")}
            />
          ))}
        </div>
      </Container>
    </section>
  );
}

function VideoCard({
  video,
  priority,
  label,
}: {
  video: BoutVideo;
  priority: boolean;
  label: string;
}) {
  const [playing, setPlaying] = React.useState(false);
  const thumb = thumbnailUrl(video.youtube_video_id);
  const duration =
    video.duration_seconds != null ? formatDuration(video.duration_seconds) : null;

  return (
    <figure className="group flex flex-col gap-3 rounded-[12px] border border-foreground/10 bg-background-elevated/55 p-3 transition-colors hover:border-foreground/25">
      <div className="relative aspect-video overflow-hidden rounded-[8px] bg-black">
        {playing ? (
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${video.youtube_video_id}?autoplay=1&rel=0`}
            title={video.title}
            className="absolute inset-0 h-full w-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            className="group/play relative block h-full w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={`Play: ${video.title}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumb}
              alt=""
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover/play:scale-[1.02]"
              loading={priority ? "eager" : "lazy"}
            />
            <span className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_transparent_30%,_rgba(0,0,0,0.55)_100%)]" />
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="inline-flex h-[64px] w-[64px] items-center justify-center rounded-full bg-[#ff0033]/95 text-white shadow-[0_8px_24px_rgba(0,0,0,0.45)] transition-transform group-hover/play:scale-110">
                <Play className="h-6 w-6 translate-x-[2px]" fill="currentColor" />
              </span>
            </span>
            <span className="absolute left-3 top-3 inline-flex items-center rounded-[4px] bg-black/70 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white">
              {label}
            </span>
            {duration ? (
              <span className="absolute bottom-3 right-3 inline-flex items-center rounded-[4px] bg-black/80 px-1.5 py-0.5 font-mono text-[11px] tracking-wide text-white">
                {duration}
              </span>
            ) : null}
          </button>
        )}
      </div>
      <figcaption className="flex items-center justify-between gap-3 px-1 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground-subtle">
        <span className="truncate" title={video.title}>
          {video.title}
        </span>
        <a
          href={`https://www.youtube.com/watch?v=${video.youtube_video_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-primary transition-colors hover:text-primary/80"
        >
          YouTube ↗
        </a>
      </figcaption>
    </figure>
  );
}
