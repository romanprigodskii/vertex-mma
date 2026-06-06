import * as React from "react";

import {
  PlatformGlyph,
  platformTileBg,
  type Platform,
} from "@/components/news/platform-icons";
import { safeHttpUrl } from "@/components/news/safe-url";

interface PlatformLinkProps {
  url: string;
  platform: Platform;
  children: React.ReactNode;
}

/** Inline link with a small colored platform tile. Used inside paragraphs
 *  for incidental references like "took to Instagram Stories". Distinct
 *  from the fighter autolinker's dotted internal link — this one is solid
 *  underline + colored glyph, semantically "external". */
export function PlatformLink({ url, platform, children }: PlatformLinkProps) {
  const href = safeHttpUrl(url);
  const glyph = (
    <span
      aria-hidden
      className="inline-flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[3px] p-[1.5px] text-white"
      style={{ background: platformTileBg(platform) }}
    >
      <PlatformGlyph platform={platform} />
    </span>
  );
  // Unsafe scheme (non-http/s) → render the glyph + label as plain text rather
  // than a clickable link, so a stored javascript:/data: value can't be opened.
  if (!href) {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-foreground">
        {glyph}
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 whitespace-nowrap border-b border-foreground-muted/45 pb-px text-foreground transition-colors hover:border-primary hover:text-primary"
    >
      {glyph}
      {children}
    </a>
  );
}
