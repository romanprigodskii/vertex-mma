"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2 } from "lucide-react";

/**
 * One-shot success banner shown after a card is deleted. The /cards page
 * renders this when navigated to with `?deleted=1`. On mount it strips the
 * flag from the URL with `history.replaceState` — which updates the address
 * bar without re-running the server component, so the banner stays mounted —
 * then auto-dismisses after a few seconds. A manual refresh no longer carries
 * the flag, so the toast never replays.
 */
export function CardDeletedNotice() {
  const t = useTranslations("cards");
  const [visible, setVisible] = React.useState(true);

  React.useEffect(() => {
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", window.location.pathname);
    }
    const id = setTimeout(() => setVisible(false), 4000);
    return () => clearTimeout(id);
  }, []);

  if (!visible) return null;
  return (
    <div
      role="status"
      className="mb-6 flex items-center gap-2 rounded-md border border-streak-win/30 bg-streak-win/10 px-4 py-3 font-sans text-sm text-streak-win"
    >
      <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
      {t("cardDeleted")}
    </div>
  );
}
