import Link from "next/link";
import * as React from "react";

import type { NewsFighter } from "@/lib/news";
import type { NewsExternalRef } from "@/lib/db/schema/news";
import { PlatformLink } from "@/components/news/platform-link";
import type { Platform } from "@/components/news/platform-icons";

/**
 * Server-side autolinker for news article paragraphs.
 *
 * Wraps the first occurrence of each related fighter's name (full name, then
 * last-name alias) with a <Link> to /fighters/{slug}. Longest aliases match
 * first so "Sean Strickland" wins over "Strickland" — otherwise we'd split
 * one name into two adjacent links.
 *
 * Returns a list of ReactNodes ready to drop into a <p>. Pass each paragraph
 * separately so a fighter's *first* mention is linked per paragraph block
 * (Wikipedia convention — readers benefit from a refresher when the same
 * name reappears far down the article).
 */

type Alias = {
  fighterId: string;
  slug: string;
  text: string;
};

function buildAliases(fighters: NewsFighter[]): Alias[] {
  const aliases: Alias[] = [];
  const seen = new Set<string>();

  for (const f of fighters) {
    const fullName = f.name.trim();
    if (fullName && !seen.has(fullName.toLowerCase())) {
      aliases.push({ fighterId: f.id, slug: f.slug, text: fullName });
      seen.add(fullName.toLowerCase());
    }
    const parts = fullName.split(/\s+/);
    if (parts.length >= 2) {
      const lastName = parts[parts.length - 1];
      // Only add last-name alias when it's distinctive — skip 2-letter
      // particles like "Du" / "De" that would over-match.
      if (lastName.length >= 4 && !seen.has(lastName.toLowerCase())) {
        aliases.push({ fighterId: f.id, slug: f.slug, text: lastName });
        seen.add(lastName.toLowerCase());
      }
    }
  }

  // Longest alias first — "Sean Strickland" before "Strickland".
  aliases.sort((a, b) => b.text.length - a.text.length);
  return aliases;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Span = {
  start: number;
  end: number;
  fighterId: string;
  slug: string;
};

/**
 * Find non-overlapping spans for the first occurrence of each alias.
 * "First occurrence per fighter" means we link the longest matching alias
 * for that fighter; further mentions stay plain text.
 */
function findSpans(text: string, aliases: Alias[]): Span[] {
  const linkedFighters = new Set<string>();
  const taken: Array<[number, number]> = [];
  const spans: Span[] = [];

  const intersectsTaken = (start: number, end: number): boolean =>
    taken.some(([s, e]) => start < e && end > s);

  for (const alias of aliases) {
    if (linkedFighters.has(alias.fighterId)) continue;
    const re = new RegExp(`\\b${escapeRegex(alias.text)}\\b`, "i");
    const m = re.exec(text);
    if (!m) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (intersectsTaken(start, end)) continue;
    spans.push({ start, end, fighterId: alias.fighterId, slug: alias.slug });
    taken.push([start, end]);
    linkedFighters.add(alias.fighterId);
  }

  spans.sort((a, b) => a.start - b.start);
  return spans;
}

type RefSpan = {
  start: number;
  end: number;
  ref: NewsExternalRef;
};

/** Find the first occurrence of each inline ref's anchor, picking longer
 *  anchors first so "Instagram Stories" wins over "Instagram". Skips refs
 *  whose anchor doesn't appear in the text (we fall back to a placement
 *  after the next paragraph in renderArticleBody). */
function findRefSpans(
  text: string,
  refs: NewsExternalRef[],
  takenRanges: Array<[number, number]>,
): RefSpan[] {
  const sorted = [...refs].sort((a, b) => b.anchor.length - a.anchor.length);
  const taken = [...takenRanges];
  const spans: RefSpan[] = [];
  const usedRefs = new Set<string>();

  const intersects = (start: number, end: number) =>
    taken.some(([s, e]) => start < e && end > s);

  for (const ref of sorted) {
    if (usedRefs.has(ref.url)) continue;
    if (!ref.anchor) continue;
    const re = new RegExp(`\\b${escapeRegex(ref.anchor)}\\b`, "i");
    const m = re.exec(text);
    if (!m) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (intersects(start, end)) continue;
    spans.push({ start, end, ref });
    taken.push([start, end]);
    usedRefs.add(ref.url);
  }

  spans.sort((a, b) => a.start - b.start);
  return spans;
}

export function autolinkParagraph(
  text: string,
  fighters: NewsFighter[],
  inlineRefs: NewsExternalRef[] = [],
): React.ReactNode[] {
  if (!text) return [];
  if (fighters.length === 0 && inlineRefs.length === 0) return [text];

  const aliases = buildAliases(fighters);
  const fighterSpans = findSpans(text, aliases);
  const takenRanges: Array<[number, number]> = fighterSpans.map((s) => [
    s.start,
    s.end,
  ]);
  const refSpans = findRefSpans(text, inlineRefs, takenRanges);

  // Merge fighter spans and ref spans into one sorted list.
  type AnySpan =
    | { type: "fighter"; start: number; end: number; slug: string; key: string }
    | {
        type: "ref";
        start: number;
        end: number;
        ref: NewsExternalRef;
        key: string;
      };
  const all: AnySpan[] = [
    ...fighterSpans.map(
      (s, i): AnySpan => ({
        type: "fighter",
        start: s.start,
        end: s.end,
        slug: s.slug,
        key: `fl-${i}-${s.slug}`,
      }),
    ),
    ...refSpans.map(
      (s, i): AnySpan => ({
        type: "ref",
        start: s.start,
        end: s.end,
        ref: s.ref,
        key: `pl-${i}-${s.ref.url}`,
      }),
    ),
  ].sort((a, b) => a.start - b.start);

  if (all.length === 0) return [text];

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  for (const span of all) {
    if (span.start > cursor) {
      nodes.push(text.slice(cursor, span.start));
    }
    const matched = text.slice(span.start, span.end);
    if (span.type === "fighter") {
      nodes.push(
        <Link
          key={span.key}
          href={`/fighters/${span.slug}`}
          prefetch={false}
          className="border-b border-dotted border-primary/60 pb-px text-foreground transition-colors hover:border-primary hover:text-primary"
        >
          {matched}
        </Link>,
      );
    } else {
      nodes.push(
        <PlatformLink
          key={span.key}
          url={span.ref.url}
          platform={span.ref.kind as Platform}
        >
          {matched}
        </PlatformLink>,
      );
    }
    cursor = span.end;
  }
  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

/** Decide which paragraph index a featured embed should follow. Returns the
 *  index of the paragraph that contains the ref's anchor, or -1 if the anchor
 *  isn't found (caller renders it after the first paragraph as a fallback). */
export function featuredEmbedParagraphIndex(
  paragraphs: string[],
  ref: NewsExternalRef,
): number {
  if (!ref.anchor) return -1;
  const re = new RegExp(`\\b${escapeRegex(ref.anchor)}\\b`, "i");
  for (let i = 0; i < paragraphs.length; i++) {
    if (re.test(paragraphs[i])) return i;
  }
  return -1;
}
