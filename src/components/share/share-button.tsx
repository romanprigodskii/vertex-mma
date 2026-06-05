"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import * as Popover from "@radix-ui/react-popover";
import { Check, Copy, Download, Share2 } from "lucide-react";

import { useMounted } from "@/hooks/use-mounted";

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
  const mounted = useMounted();
  const effectiveLabel = label ?? t("share");
  const [copied, setCopied] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);
  // Surfaced in an aria-live region so copy/save/share outcomes are both
  // visible and announced to screen readers — previously failures were a
  // silent console.error and "Copied!" was a visual-only swap. The `nonce`
  // bumps on every announce so the live region re-fires even when the same
  // message repeats (e.g. copying twice) — screen readers drop unchanged text.
  const seq = React.useRef(0);
  const [feedback, setFeedback] = React.useState<{
    tone: "success" | "error";
    text: string;
    nonce: number;
  } | null>(null);
  function announce(tone: "success" | "error", text: string) {
    seq.current += 1;
    setFeedback({ tone, text, nonce: seq.current });
  }

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

  // The native share sheet (mobile / some desktops) only exists in secure
  // contexts. Gate on `mounted` so SSR and the first client render match — the
  // native option only appears after hydration.
  const canNativeShare =
    mounted &&
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function";

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      setCopied(true);
      announce("success", t("copied"));
      setTimeout(() => setCopied(false), 1500);
    } catch {
      announce("error", t("copyFailed"));
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
      announce("success", t("imageSaved"));
    } catch (err) {
      console.error("save image failed", err);
      announce("error", t("saveFailed"));
    } finally {
      setDownloading(false);
    }
  }

  async function onNativeShare() {
    try {
      await navigator.share({ title, url: absoluteUrl });
    } catch (err) {
      // Dismissing the native sheet rejects with AbortError — not a real
      // failure, so don't surface it.
      if ((err as Error)?.name !== "AbortError") {
        announce("error", t("shareFailed"));
      }
    }
  }

  const twitterIntent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    title,
  )}&url=${encodeURIComponent(absoluteUrl)}`;
  const telegramIntent = `https://t.me/share/url?url=${encodeURIComponent(
    absoluteUrl,
  )}&text=${encodeURIComponent(title)}`;

  return (
    <Popover.Root
      onOpenChange={(open) => {
        // Reset transient state each time the popover closes so a reopen
        // starts clean (and the live region re-announces fresh outcomes).
        if (!open) {
          setFeedback(null);
          setCopied(false);
          setDownloading(false);
        }
      }}
    >
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
          {canNativeShare ? (
            <>
              <button
                type="button"
                onClick={onNativeShare}
                className="flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left font-sans text-sm text-foreground hover:bg-foreground/[0.05]"
              >
                <Share2 className="h-4 w-4 text-foreground-muted" />
                <span>{t("nativeShare")}</span>
              </button>
              <hr className="my-1 border-foreground/10" />
            </>
          ) : null}
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
          <div role="status" aria-live="polite" aria-atomic="true">
            {feedback ? (
              <p
                key={feedback.nonce}
                className={`mt-1 border-t border-foreground/10 px-3 pb-1 pt-2 font-sans text-xs ${
                  feedback.tone === "error"
                    ? "text-streak-loss"
                    : "text-streak-win"
                }`}
              >
                {feedback.text}
              </p>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
