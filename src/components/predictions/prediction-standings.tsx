import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

export type StandingRow = {
  rank: number;
  user_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  total_score: number;
  correct: number;
  /** All-time board only: number of scored events played. */
  events?: number;
};

interface Props {
  rows: StandingRow[];
  currentUserId?: string | null;
  /** Show the "events played" subtext (all-time board). */
  showEvents?: boolean;
}

/**
 * Ranked standings list shared by the per-event results board and the
 * all-time top-predictors board. Server component — data is static once
 * scored.
 */
export async function PredictionStandings({
  rows,
  currentUserId,
  showEvents = false,
}: Props) {
  const t = await getTranslations("predictions");
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((r) => {
        const isMe = currentUserId != null && r.user_id === currentUserId;
        return (
          <li key={r.user_id}>
            <Link
              href={`/profile/${r.username}`}
              prefetch={false}
              className={cn(
                "grid grid-cols-[2rem_2.25rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2.5 py-2.5 transition-colors sm:grid-cols-[2.5rem_2.5rem_minmax(0,1fr)_auto] sm:gap-3 sm:px-3",
                isMe
                  ? "border-primary/40 bg-primary/[0.06] hover:bg-primary/[0.1]"
                  : "border-foreground/10 bg-background-elevated/30 hover:bg-foreground/[0.04]",
              )}
            >
              <span className="font-display text-xl tabular text-foreground-subtle">
                #{r.rank}
              </span>
              {r.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={r.avatar_url}
                  alt={r.username}
                  className="h-9 w-9 rounded-full object-cover"
                />
              ) : (
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15 font-display text-xs uppercase text-primary">
                  {r.username.slice(0, 2)}
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate font-sans text-sm text-foreground">
                  {r.display_name || r.username}
                  {isMe ? (
                    <span className="ml-1.5 rounded-sm bg-primary/15 px-1 py-0.5 align-middle font-mono text-[9px] uppercase tracking-widest text-primary">
                      {t("youBadge")}
                    </span>
                  ) : null}
                </p>
                <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                  @{r.username}
                  {showEvents && r.events != null
                    ? ` · ${r.events} ${t("colEvents")}`
                    : ""}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-display text-lg tabular text-foreground">
                  {r.total_score.toLocaleString()}
                </p>
                <p className="font-mono text-[10px] tabular text-foreground-subtle">
                  {t("correctPicks", { n: r.correct })}
                </p>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
