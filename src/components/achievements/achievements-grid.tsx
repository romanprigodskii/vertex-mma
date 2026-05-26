import type {
  AchievementRow,
  UserAchievementRow,
} from "@/lib/achievements";
import { cn } from "@/lib/utils";

interface Props {
  unlocked: UserAchievementRow[];
  /** Full catalog — required to show locked entries grayed out. */
  allAchievements?: AchievementRow[];
  /** Compact: small initial-letter chips (e.g. inline on leaderboard). */
  compact?: boolean;
}

const RARITY_BORDER: Record<string, string> = {
  common: "border-foreground/15",
  uncommon: "border-streak-win/40",
  rare: "border-primary/50",
  epic: "border-primary/70",
  legendary: "border-gold/70",
};

export function AchievementsGrid({
  unlocked,
  allAchievements,
  compact,
}: Props) {
  if (compact) {
    if (unlocked.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1">
        {unlocked.slice(0, 8).map((a) => (
          <span
            key={a.id}
            title={`${a.name} — ${a.description}`}
            className={cn(
              "inline-flex h-6 w-6 items-center justify-center rounded-sm border bg-background-elevated/30 font-mono text-[10px] uppercase",
              RARITY_BORDER[a.rarity] ?? "border-foreground/15",
            )}
          >
            {a.name.slice(0, 1)}
          </span>
        ))}
      </div>
    );
  }

  const unlockedSlugs = new Set(unlocked.map((u) => u.slug));
  const unlockedBySlug = new Map(unlocked.map((u) => [u.slug, u]));
  // If we don't have the catalog, show only what's unlocked — that's the
  // non-owner view on a public profile.
  const all: Array<AchievementRow> = allAchievements ?? unlocked;

  if (all.length === 0) {
    return (
      <p className="rounded-md border border-foreground/10 bg-background-elevated/20 px-4 py-6 text-center font-sans text-sm text-foreground-subtle">
        No achievements yet.
      </p>
    );
  }

  return (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {all.map((a) => {
        const isUnlocked = unlockedSlugs.has(a.slug);
        const unlockedRow = unlockedBySlug.get(a.slug);
        return (
          <li
            key={a.id}
            className={cn(
              "rounded-md border p-3 transition-colors",
              isUnlocked
                ? `${RARITY_BORDER[a.rarity] ?? "border-foreground/15"} bg-background-elevated/30`
                : "border-foreground/10 bg-background-elevated/10 opacity-60",
            )}
          >
            <p
              className={cn(
                "font-sans font-bold text-sm uppercase tracking-tight",
                isUnlocked ? "text-foreground" : "text-foreground-muted",
              )}
            >
              {a.name}
            </p>
            <p className="mt-1 font-sans text-xs text-foreground-muted">
              {a.description}
            </p>
            <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
              {a.rarity}
              {a.reward_coins > 0 ? ` · +${a.reward_coins}c` : ""}
              {isUnlocked && unlockedRow
                ? ` · ${new Date(unlockedRow.unlocked_at).toLocaleDateString()}`
                : ""}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
