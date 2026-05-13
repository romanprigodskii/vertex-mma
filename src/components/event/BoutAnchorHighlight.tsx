"use client";

import * as React from "react";

/**
 * On page load, if the URL has a `#bout-<uuid>` hash, scroll to that element
 * and briefly outline it. Used by the deep-link from
 * `/fighters/[slug]` career timeline → `/events/[slug]#bout-{id}`.
 *
 * Doesn't render anything visible. Sibling to the bout list.
 */
export function BoutAnchorHighlight() {
  React.useEffect(() => {
    const hash = window.location.hash;
    if (!hash || !hash.startsWith("#bout-")) return;
    const id = hash.slice(1);
    // Wait for the next frame so the bout list has painted.
    const raf = window.requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add(
        "ring-2",
        "ring-primary/50",
        "transition-shadow",
        "duration-500",
      );
      window.setTimeout(() => {
        el.classList.remove("ring-2", "ring-primary/50");
      }, 2000);
    });
    return () => window.cancelAnimationFrame(raf);
  }, []);

  return null;
}
