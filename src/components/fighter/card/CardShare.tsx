"use client";

import * as React from "react";
import { Share2 } from "lucide-react";

import { Button } from "@/components/ui/button";

interface CardShareProps {
  fighterSlug: string;
  /** Localized tweet text (built server-side). */
  shareUrlText: string;
  /** Localized share button label. */
  shareButtonLabel: string;
}

export function CardShare({
  fighterSlug,
  shareUrlText,
  shareButtonLabel,
}: CardShareProps) {
  const [origin, setOrigin] = React.useState<string>("");
  React.useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const url = origin
    ? `${origin}/fighters/${fighterSlug}/card`
    : `/fighters/${fighterSlug}/card`;
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    shareUrlText,
  )}&url=${encodeURIComponent(url)}`;

  return (
    <div className="flex items-center gap-2">
      <Button asChild variant="outline" size="sm">
        <a href={tweetUrl} target="_blank" rel="noreferrer noopener">
          <Share2 className="h-4 w-4" />
          {shareButtonLabel}
        </a>
      </Button>
    </div>
  );
}
