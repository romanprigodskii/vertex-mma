"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import { Search } from "lucide-react";

import { Link } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

type Result = {
  slug: string;
  name: string;
  nickname: string | null;
  photo_url: string | null;
  record: string | null;
};

export function NewsSidebarSearch() {
  const t = useTranslations("news");
  const [value, setValue] = React.useState("");
  const [results, setResults] = React.useState<Result[]>([]);
  const [loading, setLoading] = React.useState(false);

  const trimmedQuery = value.trim();
  const hasQuery = trimmedQuery.length >= 2;

  React.useEffect(() => {
    if (!hasQuery) return;
    const controller = new AbortController();
    let timerActive = true;
    const timer = setTimeout(async () => {
      timerActive = false;
      setLoading(true);
      try {
        const res = await fetch(
          `/api/news-sidebar/search?q=${encodeURIComponent(trimmedQuery)}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = (await res.json()) as { results: Result[] };
        setResults(data.results);
      } catch (error) {
        if ((error as { name?: string } | null)?.name !== "AbortError") {
          setResults([]);
        }
      } finally {
        setLoading(false);
      }
    }, 220);
    return () => {
      controller.abort();
      if (timerActive) clearTimeout(timer);
    };
  }, [trimmedQuery, hasQuery]);

  // When the input drops below 2 chars, hide whatever was last fetched so
  // typing "stri" → "s" → "str" doesn't briefly flash the "stri" hits.
  const visibleResults = hasQuery ? results : [];

  return (
    <div>
      <div className="flex h-9 items-center gap-2 rounded-md border border-foreground/15 bg-background-base px-3 transition-colors focus-within:border-primary/50">
        <Search aria-hidden className="h-3.5 w-3.5 text-foreground-subtle" />
        <input
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("searchFightersPlaceholder")}
          className={cn(
            "h-full flex-1 bg-transparent text-sm text-foreground outline-none",
            "placeholder:text-foreground-subtle",
          )}
        />
      </div>

      {visibleResults.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1 border-t border-foreground/10 pt-3">
          {visibleResults.map((r) => (
            <li key={r.slug}>
              <Link
                href={`/fighters/${r.slug}`}
                prefetch={false}
                className="flex items-center gap-2.5 rounded-sm px-1 py-1.5 transition-colors hover:bg-foreground/[0.04]"
              >
                <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-background-overlay">
                  {r.photo_url ? (
                    <Image
                      src={r.photo_url}
                      alt=""
                      width={28}
                      height={28}
                      className="h-7 w-7 object-cover"
                    />
                  ) : (
                    <span className="font-mono text-[9px] text-foreground-subtle">
                      {r.name
                        .split(" ")
                        .map((s) => s[0])
                        .filter(Boolean)
                        .slice(0, 2)
                        .join("")
                        .toUpperCase()}
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {r.name}
                </span>
                {r.record ? (
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground-subtle">
                    {r.record}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : hasQuery && !loading ? (
        <p className="mt-3 border-t border-foreground/10 pt-3 font-sans text-xs text-foreground-subtle">
          {t("noFightersMatch", { query: trimmedQuery })}
        </p>
      ) : null}
    </div>
  );
}
