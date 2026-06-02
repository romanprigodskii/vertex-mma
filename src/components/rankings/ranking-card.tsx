import { getLocale } from "next-intl/server";

import { Link } from "@/i18n/navigation";

import type { RankingListItem } from "@/lib/rankings";

interface Props {
  ranking: RankingListItem;
}

export async function RankingCard({ ranking }: Props) {
  const locale = await getLocale();
  const date = new Date(ranking.created_at);
  const dateLabel = date.toLocaleDateString(locale === "ru" ? "ru-RU" : "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <Link
      href={`/rankings/${ranking.id}`}
      prefetch={false}
      className="block rounded-md border border-foreground/10 bg-background-elevated/30 p-4 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.04]"
    >
      <h3 className="font-display text-lg uppercase tracking-tight text-foreground line-clamp-2">
        {ranking.title}
      </h3>
      {ranking.description ? (
        <p className="mt-2 font-sans text-sm text-foreground-muted line-clamp-2">
          {ranking.description}
        </p>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-2 font-mono text-[11px] tabular text-foreground-subtle">
        <span className="truncate">by @{ranking.author_username}</span>
        <span className="shrink-0">
          {ranking.entry_count} fighter{ranking.entry_count === 1 ? "" : "s"}
          {" · "}
          {dateLabel}
        </span>
      </div>
    </Link>
  );
}
