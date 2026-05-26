import Link from "next/link";
import * as React from "react";

import type { NewsFighter } from "@/lib/news";
import type { MentionedEvent } from "@/lib/event-detail";
import type { NewsExternalRef } from "@/lib/db/schema/news";
import { PlatformLink } from "@/components/news/platform-link";
import type { Platform } from "@/components/news/platform-icons";

/**
 * Server-side autolinker for news article paragraphs.
 *
 * Wraps the first occurrence of each fighter / event mention with a <Link>
 * to its profile page. Longest aliases match first so "Sean Strickland"
 * wins over "Strickland" — otherwise we'd split one name into two adjacent
 * links. Same rule for events: "UFC 326: Du Plessis vs Strickland" beats
 * "UFC 326".
 *
 * Returns a list of ReactNodes ready to drop into a <p>. Pass each paragraph
 * separately so a target's *first* mention is linked per paragraph block
 * (Wikipedia convention — readers benefit from a refresher when the same
 * name reappears far down the article).
 */

type TargetType = "fighter" | "event";

type Alias = {
  targetId: string;
  targetType: TargetType;
  slug: string;
  text: string;
};

function buildAliases(
  fighters: NewsFighter[],
  events: MentionedEvent[],
): Alias[] {
  const aliases: Alias[] = [];
  const seen = new Set<string>();

  const add = (
    text: string,
    targetId: string,
    targetType: TargetType,
    slug: string,
  ) => {
    const key = `${targetType}:${text.toLowerCase()}`;
    if (!text || seen.has(key)) return;
    aliases.push({ targetId, targetType, slug, text });
    seen.add(key);
  };

  for (const f of fighters) {
    const fullName = f.name.trim();
    add(fullName, f.id, "fighter", f.slug);
    const parts = fullName.split(/\s+/);
    if (parts.length >= 2) {
      const lastName = parts[parts.length - 1];
      // Only add last-name alias when it's distinctive — skip 2-letter
      // particles like "Du" / "De" that would over-match.
      if (lastName.length >= 4) {
        add(lastName, f.id, "fighter", f.slug);
      }
    }
  }

  for (const e of events) {
    // Longer forms first so "UFC 326: Holloway vs. Oliveira 2" wraps the
    // whole subtitle when present. Falls back to the prefix `match_text`
    // (e.g., "UFC 326") when the body only cites the short form — which
    // is the common case.
    const short = e.short_name?.trim();
    if (short && short.length >= 5) add(short, e.id, "event", e.slug);
    const fullName = e.name?.trim();
    if (fullName && fullName.length >= 5) add(fullName, e.id, "event", e.slug);
    const matchText = e.match_text?.trim();
    if (matchText && matchText.length >= 5)
      add(matchText, e.id, "event", e.slug);
  }

  // Longest alias first — "Sean Strickland" before "Strickland", "UFC 326:
  // Du Plessis vs Strickland" before "UFC 326".
  aliases.sort((a, b) => b.text.length - a.text.length);
  return aliases;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Span = {
  start: number;
  end: number;
  targetType: TargetType;
  slug: string;
};

/**
 * Find non-overlapping spans for the first occurrence of each alias.
 * "First occurrence per target" means we link the longest matching alias
 * for that target; further mentions stay plain text.
 */
function findSpans(text: string, aliases: Alias[]): Span[] {
  const linkedTargets = new Set<string>();
  const taken: Array<[number, number]> = [];
  const spans: Span[] = [];

  const intersectsTaken = (start: number, end: number): boolean =>
    taken.some(([s, e]) => start < e && end > s);

  for (const alias of aliases) {
    const targetKey = `${alias.targetType}:${alias.targetId}`;
    if (linkedTargets.has(targetKey)) continue;
    const re = new RegExp(`\\b${escapeRegex(alias.text)}\\b`, "i");
    const m = re.exec(text);
    if (!m) continue;
    const start = m.index;
    const end = start + m[0].length;
    if (intersectsTaken(start, end)) continue;
    spans.push({
      start,
      end,
      targetType: alias.targetType,
      slug: alias.slug,
    });
    taken.push([start, end]);
    linkedTargets.add(targetKey);
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
  events: MentionedEvent[] = [],
  inlineRefs: NewsExternalRef[] = [],
): React.ReactNode[] {
  if (!text) return [];
  if (
    fighters.length === 0 &&
    events.length === 0 &&
    inlineRefs.length === 0
  ) {
    return [text];
  }

  const aliases = buildAliases(fighters, events);
  const targetSpans = findSpans(text, aliases);
  const takenRanges: Array<[number, number]> = targetSpans.map((s) => [
    s.start,
    s.end,
  ]);
  const refSpans = findRefSpans(text, inlineRefs, takenRanges);

  // Merge fighter / event spans and ref spans into one sorted list.
  type AnySpan =
    | {
        kind: "target";
        start: number;
        end: number;
        targetType: TargetType;
        slug: string;
        key: string;
      }
    | {
        kind: "ref";
        start: number;
        end: number;
        ref: NewsExternalRef;
        key: string;
      };
  const all: AnySpan[] = [
    ...targetSpans.map(
      (s, i): AnySpan => ({
        kind: "target",
        start: s.start,
        end: s.end,
        targetType: s.targetType,
        slug: s.slug,
        key: `${s.targetType[0]}l-${i}-${s.slug}`,
      }),
    ),
    ...refSpans.map(
      (s, i): AnySpan => ({
        kind: "ref",
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
    if (span.kind === "target") {
      const href =
        span.targetType === "fighter"
          ? `/fighters/${span.slug}`
          : `/events/${span.slug}`;
      nodes.push(
        <Link
          key={span.key}
          href={href}
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
