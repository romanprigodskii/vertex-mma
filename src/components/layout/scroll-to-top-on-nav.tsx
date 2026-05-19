"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

/**
 * Forces the window to scroll to top whenever the pathname changes.
 *
 * Next.js usually does this on hard navigations, but it sometimes
 * preserves scroll position on `router.push` / back-forward where we
 * don't want it (going from /fighters/[slug] → /markets shouldn't open
 * /markets two thousand pixels down). Listening to pathname (NOT
 * `searchParams` or hash) keeps anchor jumps like `/events/X#bout-Y`
 * working — those don't change pathname so this effect doesn't fire.
 *
 * Instant scroll (no smooth), so the user never sees the page "fall"
 * after the route swap.
 */
export function ScrollToTopOnNav() {
  const pathname = usePathname();
  React.useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" as ScrollBehavior });
  }, [pathname]);
  return null;
}
