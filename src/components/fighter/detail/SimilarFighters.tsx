import { getTranslations } from "next-intl/server";

import { FighterAvatar } from "@/components/fighter/FighterAvatar";
import { Link } from "@/i18n/navigation";
import { getCountryFlag } from "@/lib/fighter-helpers";
import type { SimilarFighter } from "@/lib/similar-fighters";
import { cn } from "@/lib/utils";

interface SimilarFightersProps {
  fighters: SimilarFighter[];
}

export async function SimilarFighters({ fighters }: SimilarFightersProps) {
  const t = await getTranslations("fighter");
  if (fighters.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/10 bg-background-elevated/30 px-6 py-10 text-center">
        <p className="font-sans text-sm text-foreground-muted">
          {t("noStatSimilar")}
        </p>
        <p className="mt-1 font-sans text-xs text-foreground-subtle">
          {t("noStatSimilarHint")}
        </p>
      </div>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {fighters.map((f) => {
        const flag = getCountryFlag(f.country_code);
        const record = `${f.wins_total}-${f.losses_total}`;
        const sim = Math.round(f.similarity * 100);
        return (
          <li key={f.id}>
            <Link
              href={`/fighters/${f.slug}`}
              prefetch={false}
              className={cn(
                "group flex items-center gap-3 rounded-md border border-foreground/10 bg-background-elevated/30 p-3",
                "transition-[border-color,background-color] duration-200 ease-out",
                "hover:border-primary/40 hover:bg-foreground/[0.02]",
                "focus-visible:outline-none focus-visible:border-primary/50",
                "focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background-base",
              )}
              aria-label={`${f.name_en}, ${t("similarPercent", { pct: sim })}`}
            >
              <FighterAvatar
                name={f.name_en}
                photoUrl={f.photo_url}
                size="md"
                imageSizes="64px"
              />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-display text-lg uppercase leading-tight tracking-tight text-foreground">
                  {f.name_en}
                </span>
                {f.nickname ? (
                  <span className="truncate font-sans text-[11px] italic leading-snug text-foreground-muted">
                    &ldquo;{f.nickname}&rdquo;
                  </span>
                ) : null}
                <span className="mt-0.5 flex items-center gap-1.5 font-sans text-[11px] text-foreground-subtle">
                  <span aria-hidden className="text-[13px] leading-none">
                    {flag}
                  </span>
                  <span className="font-mono tabular text-foreground">
                    {record}
                  </span>
                  <span aria-hidden className="text-foreground-subtle/40">
                    ·
                  </span>
                  <span className="tabular">{f.ufc_total}</span>{" "}
                  {t("ufcBoutsInline")}
                </span>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-0.5">
                <span className="font-display tabular text-xl tracking-tight text-primary">
                  {sim}%
                </span>
                <span className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {t("similarLabel")}
                </span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
