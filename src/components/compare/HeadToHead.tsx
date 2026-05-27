import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import type { HeadToHeadBout } from "@/lib/compare-fighters";
import { abbreviateMethod } from "@/lib/method";

interface HeadToHeadProps {
  bouts: HeadToHeadBout[];
  fighterAName: string;
  fighterBName: string;
}

function formatRoundTime(sec: number | null): string {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function HeadToHead({
  bouts,
  fighterAName,
  fighterBName,
}: HeadToHeadProps) {
  const t = useTranslations("compare");
  if (bouts.length === 0) {
    return (
      <p className="py-6 text-center font-sans text-sm text-foreground-muted">
        {t("neverMet", { a: fighterAName, b: fighterBName })}
      </p>
    );
  }

  return (
    <ul className="mt-4 flex flex-col">
      {bouts.map((bout) => {
        const date = bout.event_date.slice(0, 10);
        const methodLabel = abbreviateMethod(bout.method);
        const time = formatRoundTime(bout.time_finished_seconds);
        const finishDetail = bout.round_finished
          ? `${t("roundShort", { n: bout.round_finished })}${time ? ` · ${time}` : ""}`
          : null;
        const winnerName =
          bout.a_result === "W"
            ? fighterAName
            : bout.a_result === "L"
              ? fighterBName
              : null;
        return (
          <li
            key={bout.bout_id}
            className="border-b border-foreground/[0.06] py-3 last:border-b-0"
          >
            <Link
              href={`/bouts/${bout.bout_id}`}
              prefetch={false}
              className="-mx-2 grid grid-cols-1 gap-x-4 gap-y-1 rounded-sm px-2 py-1 transition-colors hover:bg-foreground/[0.03] sm:grid-cols-[minmax(0,1fr)_auto]"
            >
              <div className="min-w-0">
                <p className="truncate font-sans text-sm text-foreground">
                  {winnerName ? (
                    <span>
                      <span className="text-streak-win">{winnerName}</span>{" "}
                      <span className="text-foreground-muted">
                        {t("byMethodConnector", { method: methodLabel })}
                      </span>
                    </span>
                  ) : bout.a_result === "D" ? (
                    <span className="text-foreground-muted">
                      {t("drawByMethod", { method: methodLabel })}
                    </span>
                  ) : (
                    <span className="text-foreground-muted">
                      {t("noContestLabel")}
                    </span>
                  )}
                  {bout.is_title_fight ? (
                    <span className="ml-2 rounded-sm border border-primary/35 bg-primary/10 px-1.5 py-0.5 font-sans text-[9px] uppercase tracking-widest text-primary">
                      {t("titleBadge")}
                    </span>
                  ) : null}
                </p>
                <p className="mt-0.5 font-mono text-[11px] tabular text-foreground-subtle">
                  {date} · {bout.event_name}
                  {finishDetail ? ` · ${finishDetail}` : ""}
                </p>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
