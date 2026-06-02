import * as React from "react";
import { getLocale, getTranslations } from "next-intl/server";
import { Play } from "lucide-react";

import {
  PlatformGlyph,
  platformDisplayName,
  platformTileBg,
  type Platform,
} from "@/components/news/platform-icons";
import { cn } from "@/lib/utils";

export type SocialEmbedData = {
  /** Platform-specific styling. */
  platform: Platform;
  /** Destination URL — opens in a new tab. */
  url: string;
  /** Display name of the poster (e.g., "Sean Strickland"). */
  author?: string | null;
  /** Handle / context line (e.g., "@sstricklandmma · Instagram Story"). */
  handle?: string | null;
  /** Post body in italics. */
  quote?: string | null;
  /** ISO date of the post. */
  posted_at?: string | null;
  /** YouTube preview thumbnail URL. */
  thumbnail_url?: string | null;
  /** YouTube duration label, e.g., "4:23". */
  duration?: string | null;
};

function formatPostedDate(iso: string, locale: string): string {
  return new Date(iso)
    .toLocaleDateString(locale === "ru" ? "ru-RU" : "en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();
}

function authorInitials(author: string | null | undefined): string {
  if (!author) return "";
  return author
    .split(/\s+/)
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Self-rendered social card. We never load Instagram embed.js, X widgets.js,
 *  or YouTube iframe_api.js — privacy-friendly, fast, consistently themed.
 *  YouTube thumbnails are pre-fetched at ingest and stored on the row. */
export async function SocialEmbed({
  embed,
  compact = false,
}: {
  embed: SocialEmbedData;
  compact?: boolean;
}) {
  const t = await getTranslations("news");
  const locale = await getLocale();
  const showQuote = Boolean(embed.quote && embed.quote.trim().length > 0);
  const isYouTube = embed.platform === "youtube";
  const showThumb = isYouTube && Boolean(embed.thumbnail_url);

  return (
    <a
      href={embed.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "not-prose group my-7 flex flex-col gap-3 rounded-[10px] border border-foreground/10 bg-background-elevated/55 p-4 transition-colors hover:border-foreground/25 hover:bg-background-elevated/80",
        compact && "my-2.5",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] p-1.5 text-white"
          style={{ background: platformTileBg(embed.platform) }}
        >
          <PlatformGlyph platform={embed.platform} />
        </span>
        <div className="flex min-w-0 flex-col leading-tight">
          {embed.author ? (
            <span className="text-sm font-semibold text-foreground">
              {embed.author}
            </span>
          ) : (
            <span className="text-sm font-semibold text-foreground">
              {authorInitials(embed.author) || platformDisplayName(embed.platform)}
            </span>
          )}
          {embed.handle ? (
            <span className="font-mono text-[11px] tracking-wide text-foreground-subtle">
              {embed.handle}
            </span>
          ) : null}
        </div>
      </div>

      {showQuote ? (
        <p
          className={cn(
            "m-0 font-serif italic leading-[1.42] text-foreground",
            compact ? "text-[15px]" : "text-[19px]",
          )}
          style={{ fontFamily: "ui-serif, Georgia, serif" }}
        >
          {embed.quote}
        </p>
      ) : null}

      {showThumb ? (
        <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-md bg-gradient-to-br from-background-overlay to-background-base">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={embed.thumbnail_url!}
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            loading="lazy"
          />
          <span className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_transparent_40%,_rgba(0,0,0,0.55)_100%)]" />
          <span className="relative z-[1] inline-flex h-[52px] w-[52px] items-center justify-center rounded-full bg-[#ff0033]/90 text-white shadow-[0_4px_16px_rgba(0,0,0,0.4)]">
            <Play className="h-5 w-5 translate-x-[1px]" fill="currentColor" />
          </span>
          {embed.duration ? (
            <span className="absolute bottom-2 right-2.5 z-[2] rounded-[3px] bg-black/75 px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-white">
              {embed.duration}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground-subtle">
        <span>
          {embed.posted_at
            ? formatPostedDate(embed.posted_at, locale)
            : platformDisplayName(embed.platform)}
        </span>
        <span className="text-primary group-hover:underline">
          {isYouTube
            ? t("watch")
            : t("viewOn", { platform: platformDisplayName(embed.platform) })}{" "}
          →
        </span>
      </div>
    </a>
  );
}

export async function SocialReactions({
  embeds,
}: {
  embeds: SocialEmbedData[];
}) {
  if (embeds.length === 0) return null;
  const t = await getTranslations("news");
  return (
    <section className="mt-8 border-t border-foreground/10 pt-5">
      <p className="mb-3 font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-foreground-subtle">
        {t("socialReactions")}
      </p>
      <div className="flex flex-col gap-2.5">
        {embeds.map((e) => (
          <SocialEmbed key={e.url} embed={e} compact />
        ))}
      </div>
    </section>
  );
}
