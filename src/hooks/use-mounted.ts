import { useEffect, useState } from "react";

/** `false` on the server and on the first client render, flipping to `true`
 *  after mount. Use it to gate any value derived from the current clock
 *  (relative "5m ago" strings, cooldown countdowns, etc.) so the server output
 *  and the first client render are identical — eliminating hydration mismatches
 *  at minute/hour boundaries. Render a deterministic placeholder until mounted
 *  and add `suppressHydrationWarning` to the host element, mirroring the
 *  NewsTimestamp pattern. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  // One-time "have we hydrated yet" flip — not render-driven state sync — so
  // the cascading-render concern behind react-hooks/set-state-in-effect does
  // not apply here (same effect-on-mount pattern as NewsTimestamp / mobile-nav).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);
  return mounted;
}
