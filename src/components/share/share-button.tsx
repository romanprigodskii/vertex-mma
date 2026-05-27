"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import * as Popover from "@radix-ui/react-popover";
import { Check, Copy, Download, Share2 } from "lucide-react";

interface ShareButtonProps {
  /** Path or absolute URL to share. Resolved to absolute via window.location.origin. */
  url: string;
  /** OG image route (relative or absolute). Fetched and downloaded for "Save image". */
  ogImageUrl: string;
  /** Title used in share-intent text (X / Telegram). */
  title: string;
  /** Filename stem for the downloaded image — `.png` appended automatically. */
  filename: string;
  /** Button label (aria + tooltip text). */
  label?: string;
  /** Visual variant. "primary" = labelled button, "icon" = bare icon for tight spots. */
  variant?: "primary" | "icon";
}

export function ShareButton({
  url,
  ogImageUrl,
  title,
  filename,
  label,
  variant = "primary",
}: ShareButtonProps) {
  const t = useTranslations("share");
  const effectiveLabel = label ?? t("share");
  const [copied, setCopied] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);

  // Resolve to absolute URLs on first client render — the server-rendered
  // useMemo would just get the relative input back, which is fine for
  // share-intent links once the popover opens.
  const absoluteUrl = React.useMemo(() => {
    if (typeof window === "undefined") return url;
    return url.startsWith("http") ? url : `${window.location.origin}${url}`;
  }, [url]);

  const absoluteOgUrl = React.useMemo(() => {
    if (typeof window === "undefined") return ogImageUrl;
    return ogImageUrl.startsWith("http")
      ? ogImageUrl
      : `${window.location.origin}${ogImageUrl}`;
  }, [ogImageUrl]);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Older / locked-down browsers — silently no-op rather than throw.
    }
  }

  async function onSaveImage() {
    setDownloading(true);
    try {
      const res = await fetch(absoluteOgUrl);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `${filename}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error("save image failed", err);
    } finally {
      setDownloading(false);
    }
  }

  const twitterIntent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    title,
  )}&url=${encodeURIComponent(absoluteUrl)}`;
  const telegramIntent = `https://t.me/share/url?url=${encodeURIComponent(
    absoluteUrl,
  )}&text=${encodeURIComponent(title)}`;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        {variant === "icon" ? (
          <button
            type="button"
            aria-label={effectiveLabel}
            title={effectiveLabel}
            className="rounded-sm p-1.5 text-foreground-muted transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <Share2 className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-sm border border-foreground/15 px-3 py-1.5 font-sans text-sm text-foreground-muted transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <Share2 className="h-4 w-4" />
            <span>{effectiveLabel}</span>
          </button>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-64 rounded-md border border-foreground/10 bg-background-elevated p-1 shadow-lg"
        >
          <button
            type="button"
            onClick={onCopy}
            className="flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left font-sans text-sm text-foreground hover:bg-foreground/[0.05]"
          >
            {copied ? (
              <Check className="h-4 w-4 text-streak-win" />
            ) : (
              <Copy className="h-4 w-4 text-foreground-muted" />
            )}
            <span>{copied ? t("copied") : t("copyLink")}</span>
          </button>
          <button
            type="button"
            onClick={onSaveImage}
            disabled={downloading}
            className="flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left font-sans text-sm text-foreground hover:bg-foreground/[0.05] disabled:opacity-50"
          >
            <Download className="h-4 w-4 text-foreground-muted" />
            <span>{downloading ? t("downloading") : t("saveImage")}</span>
          </button>
          <hr className="my-1 border-foreground/10" />
          <a
            href={twitterIntent}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-full items-center gap-3 rounded-sm px-3 py-2 font-sans text-sm text-foreground hover:bg-foreground/[0.05]"
          >
            <span className="font-display text-base text-foreground-muted">
              X
            </span>
            <span>{t("shareToX")}</span>
          </a>
          <a
            href={telegramIntent}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-full items-center gap-3 rounded-sm px-3 py-2 font-sans text-sm text-foreground hover:bg-foreground/[0.05]"
          >
            <span className="font-display text-base text-foreground-muted">
              TG
            </span>
            <span>{t("shareToTelegram")}</span>
          </a>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
