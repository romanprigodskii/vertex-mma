import { useTranslations } from "next-intl";

import { Link } from "@/i18n/navigation";
import type { CommonOpponentBout, CommonOpponentEntry } from "@/lib/compare-fighters";
import { cn } from "@/lib/utils";

const METHOD_KEY: Record<string, string> = {
  ko: "methodKo",
  tko: "methodTko",
  submission: "methodSub",
  decision_unanimous: "methodUDec",
  decision_split: "methodSDec",
  decision_majority: "methodMDec",
  draw: "methodDraw",
  no_contest: "methodNc",
  dq: "methodDq",
};

function formatRoundTime(sec: number | null): string {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function resultClass(result: CommonOpponentBout["result"]): string {
  switch (result) {
    case "W":
      return "text-streak-win";
    case "L":
      return "text-streak-loss";
    default:
      return "text-foreground-muted";
  }
}

function BoutLine({
  label,
  bout,
}: {
  label: string;
  bout: CommonOpponentBout;
}) {
  const tHistory = useTranslations("scoreHistory");
  const tCompare = useTranslations("compare");
  const method = (() => {
    if (!bout.method) return null;
    const key = METHOD_KEY[bout.method];
    if (key) return tHistory(key as "methodKo");
    return bout.method;
  })();
  const timeStr = formatRoundTime(bout.time_finished_seconds);
  const finishDetail = bout.round_finished
    ? `${tCompare("roundShort", { n: bout.round_finished })}${timeStr ? ` · ${timeStr}` : ""}`
    : null;
  return (
    <div className="grid grid-cols-[56px_auto_minmax(0,1fr)] items-baseline gap-2 font-sans text-sm text-foreground-muted sm:grid-cols-[88px_auto_minmax(0,1fr)] sm:gap-3">
      <span className="font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
        {label}
      </span>
      <span
        className={cn(
          "font-display tabular text-base tracking-wider",
          resultClass(bout.result),
        )}
      >
        {bout.result}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-1.5">
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          {method ? <span>{method}</span> : null}
          {finishDetail ? (
            <>
              <span aria-hidden className="text-foreground-subtle/40">
                ·
              </span>
              <span className="font-mono tabular text-foreground-subtle">
                {finishDetail}
              </span>
            </>
          ) : null}
        </span>
        <span className="flex min-w-0 items-baseline gap-x-1.5">
          <span aria-hidden className="hidden text-foreground-subtle/40 sm:inline">
            ·
          </span>
          <Link
            href={`/events/${bout.event_slug}`}
            prefetch={false}
            className="min-w-0 truncate text-foreground transition-colors hover:text-primary"
          >
            {bout.event_name}
          </Link>
          <span aria-hidden className="text-foreground-subtle/40">
            ·
          </span>
          <span className="font-mono tabular text-foreground-subtle">
            {bout.event_date.slice(0, 10)}
          </span>
        </span>
      </div>
    </div>
  );
}

interface CommonOpponentsProps {
  entries: CommonOpponentEntry[];
  fighterAName: string;
  fighterBName: string;
}

export function CommonOpponents({
  entries,
  fighterAName,
  fighterBName,
}: CommonOpponentsProps) {
  const t = useTranslations("compare");
  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/10 bg-background-elevated/30 px-6 py-10 text-center">
        <p className="font-sans text-base text-foreground-muted">
          {t("noCommonBetween", { a: fighterAName, b: fighterBName })}
        </p>
      </div>
    );
  }

  return (
    <ul className="mx-auto flex max-w-3xl flex-col gap-4">
      {entries.map((e) => (
        <li
          key={e.opponent_slug}
          className="rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-4 sm:px-5"
        >
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <Link
              href={`/fighters/${e.opponent_slug}`}
              prefetch={false}
              className="min-w-0 font-display text-2xl uppercase tracking-tight text-foreground transition-colors hover:text-primary sm:text-3xl"
            >
              {e.opponent_name}
            </Link>
            {e.opponent_nickname ? (
              <span className="min-w-0 truncate font-sans text-sm italic text-foreground-subtle">
                &ldquo;{e.opponent_nickname}&rdquo;
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <BoutLine label={fighterAName.split(" ")[0]} bout={e.a_bout} />
            <BoutLine label={fighterBName.split(" ")[0]} bout={e.b_bout} />
          </div>
        </li>
      ))}
    </ul>
  );
}
