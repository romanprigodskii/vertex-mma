"use client";

import { useTranslations } from "next-intl";

/** Keyboard/screen-reader skip link — the first focusable element in the body.
 *  Hidden until focused, then jumps focus past the sticky navbar (8 nav links
 *  plus search/toggles/account controls) straight to the page content.
 *
 *  Pages render their own <main>, so the target is resolved at activation time:
 *  prefer an explicit #main-content, otherwise fall back to the first <main> and
 *  make it programmatically focusable on the fly. This keeps the link working on
 *  every route without touching each page. */
export function SkipToContent() {
  const t = useTranslations("nav");
  return (
    <a
      href="#main-content"
      onClick={(e) => {
        const target =
          document.getElementById("main-content") ??
          document.querySelector("main");
        if (!(target instanceof HTMLElement)) return;
        e.preventDefault();
        if (!target.hasAttribute("tabindex")) {
          target.setAttribute("tabindex", "-1");
        }
        target.focus();
        target.scrollIntoView();
      }}
      className="sr-only left-4 top-4 z-[100] rounded-md border border-foreground/20 bg-background-elevated px-4 py-2 font-sans text-sm font-medium text-foreground shadow-elevation-2 focus:not-sr-only focus:fixed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {t("skipToContent")}
    </a>
  );
}
