"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import type { NotificationRow } from "@/lib/notifications";

type Params = Record<string, unknown> | null;

function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Localize a notification's title/body from its structured `params` payload
 * ({ key, …values } dual-written by the settle/achievement/tier functions).
 *
 * Resolution order, with the stored English title/body as the ultimate
 * fallback at every step, so a missing i18n key or a legacy (params=null) row
 * never renders blank:
 *   • no params.key                       → stored title/body
 *   • key 'achievement' (slug→catalog)    → localized name + description
 *   • key with a matching title_<key>     → localized template(s)
 *   • anything else                       → stored title/body
 */
export function useLocalizedNotification(): (n: NotificationRow) => {
  title: string;
  body: string | null;
} {
  const t = useTranslations("notifications");
  const tAch = useTranslations("achievements");

  return React.useCallback(
    (n: NotificationRow) => {
      const p = (n.params ?? null) as Params;
      const key = p && typeof p.key === "string" ? p.key : null;
      if (!key) return { title: n.title, body: n.body };

      // Achievement: localized name + description resolved from the slug.
      if (key === "achievement") {
        const slug = str(p!.slug);
        const reward = num(p!.reward);
        const hasName = slug && tAch.has(`${slug}.name`);
        if (!hasName) return { title: n.title, body: n.body };
        const name = tAch(`${slug}.name`);
        const description = tAch.has(`${slug}.description`)
          ? tAch(`${slug}.description`)
          : "";
        const title = t("title_achievement", { name });
        const body =
          reward > 0
            ? t("body_achievement_reward", { description, coins: reward })
            : description || n.body;
        return { title, body };
      }

      const titleKey = `title_${key}`;
      if (!t.has(titleKey)) return { title: n.title, body: n.body };

      // Tier is a raw DB enum (bronze/silver/gold/diamond/champion); localize it
      // via the tier_* labels so the RU title doesn't read "Повышение уровня ·
      // ELITE". Fall back to the uppercased raw value for any unknown tier.
      const rawTier = str(p!.tier);
      const tierKey = `tier_${rawTier.toLowerCase()}`;
      const args = {
        coins: num(p!.coins),
        total: num(p!.total),
        shares: num(p!.shares),
        label: str(p!.label),
        reason: str(p!.reason),
        tier: t.has(tierKey) ? t(tierKey) : rawTier.toUpperCase(),
      };
      const title = t(titleKey, args);
      const bodyKey = `body_${key}`;
      const body = t.has(bodyKey) ? t(bodyKey, args) : n.body;
      return { title, body };
    },
    [t, tAch],
  );
}
