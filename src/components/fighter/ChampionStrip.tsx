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
 * Horizontal carousel of all current-champion cards. Native overflow-x scroll
 * with snap; no external library. Slides in as one block on mount.
 *
 * Parent (FighterCatalogClient) hides the entire strip when any filter is
 * active or the search input has content — this is a discovery aid for the
 * unfiltered view only.
 */
export function ChampionStrip({ fightersBySlug }: ChampionStripProps) {
  if (CURRENT_CHAMPIONS.length === 0) return null;

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
      <div className="champion-strip-scroll flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 sm:px-6 lg:px-8">
        {CURRENT_CHAMPIONS.map((entry) => (
          <ChampionCard
            key={entry.slug}
            entry={entry}
            fighter={fightersBySlug[entry.slug] ?? null}
          />
        ))}
      </div>
    </motion.section>
  );
}
