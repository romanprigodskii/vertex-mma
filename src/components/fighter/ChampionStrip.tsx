"use client";

import * as React from "react";
import { motion } from "framer-motion";

import { ChampionCard } from "@/components/fighter/ChampionCard";
import { CURRENT_CHAMPIONS } from "@/lib/champions";
import type { FighterCatalogRow } from "@/lib/fighter-search";

interface ChampionStripProps {
  fightersBySlug: Record<string, FighterCatalogRow>;
}

/**
 * Infinite-loop marquee of all current-champion cards. We render two copies of
 * the champion list back-to-back and animate the track from `translateX(0)`
 * to `translateX(-50%)` — at -50% the second copy lands pixel-identical to
 * the start of the first, so the loop is seamless.
 *
 * The track pauses while the user hovers anywhere over the strip (uses the
 * Tailwind `group-hover` arbitrary-variant trick on `animation-play-state`).
 * `prefers-reduced-motion: reduce` disables the animation entirely (see
 * globals.css), which is important for users who find auto-scrolling
 * disorienting.
 *
 * Click → /fighters/{slug}, exactly as before.
 */
export function ChampionStrip({ fightersBySlug }: ChampionStripProps) {
  if (CURRENT_CHAMPIONS.length === 0) return null;

  // Duplicate the array so a -50% translate on the wrapping flex track
  // produces a perfect seam. The second pass is `aria-hidden` so screen
  // readers don't announce 24 champions instead of 12.
  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      aria-labelledby="champions-heading"
      className="-mx-4 sm:-mx-6 lg:-mx-8"
    >
      <div className="flex items-baseline justify-between gap-2 px-4 pb-3 sm:px-6 lg:px-8">
        <h2
          id="champions-heading"
          className="font-display text-xl uppercase tracking-[0.16em] text-foreground"
        >
          Current Champions
        </h2>
        <p className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
          {CURRENT_CHAMPIONS.length} belts
        </p>
      </div>

      {/* Edge gradients fade the track in/out for a "no hard boundary" feel.
          The track itself is the moving element; the wrapper holds the mask. */}
      <div
        className="group relative overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(to right, transparent 0, black 24px, black calc(100% - 24px), transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to right, transparent 0, black 24px, black calc(100% - 24px), transparent 100%)",
        }}
      >
        <ul
          className="flex w-max gap-3 px-4 py-2 animate-marquee group-hover:[animation-play-state:paused] sm:px-6 lg:px-8"
        >
          {CURRENT_CHAMPIONS.map((entry) => (
            <li key={`a-${entry.slug}`} className="list-none">
              <ChampionCard
                entry={entry}
                fighter={fightersBySlug[entry.slug] ?? null}
              />
            </li>
          ))}
          {CURRENT_CHAMPIONS.map((entry) => (
            <li
              key={`b-${entry.slug}`}
              className="list-none"
              aria-hidden
            >
              <ChampionCard
                entry={entry}
                fighter={fightersBySlug[entry.slug] ?? null}
              />
            </li>
          ))}
        </ul>
      </div>
    </motion.section>
  );
}
