import { getLocale, getTranslations } from "next-intl/server";

import type { FighterDetail } from "@/lib/fighter-detail";
import { getCountryFlag } from "@/lib/fighter-helpers";

// Locale-aware country name lookup. Re-creating Intl.DisplayNames every
// request is cheap (cached internally by the runtime) and lets us switch
// between "United States" / "США" without a hand-curated map.
function countryName(code: string | null, locale: string): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function formatDob(dob: string | null): { display: string; age: number | null } {
  if (!dob) return { display: "—", age: null };
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return { display: dob, age: null };
  const display = dob.slice(0, 10); // YYYY-MM-DD
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age -= 1;
  return { display, age };
}

interface PhysicalInfoProps {
  fighter: FighterDetail;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-foreground/[0.06] py-2.5 last:border-b-0">
      <dt className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
        {label}
      </dt>
      <dd className="font-sans text-sm text-foreground">{value}</dd>
    </div>
  );
}

export async function PhysicalInfo({ fighter }: PhysicalInfoProps) {
  const t = await getTranslations("fighter");
  const locale = await getLocale();
  const { display: dobDisplay, age } = formatDob(fighter.dob);
  const cn_label = countryName(fighter.country_code, locale);
  const flag = getCountryFlag(fighter.country_code);
  const stanceLabel = fighter.stance
    ? t.has(`stance_value.${fighter.stance}`)
      ? t(`stance_value.${fighter.stance}`)
      : fighter.stance
    : null;

  return (
    <dl className="flex flex-col">
      <Row
        label={t("height")}
        value={fighter.height_cm ? `${fighter.height_cm} cm` : "—"}
      />
      <Row
        label={t("reach")}
        value={fighter.reach_cm ? `${fighter.reach_cm} cm` : "—"}
      />
      <Row
        label={t("legReach")}
        value={fighter.leg_reach_cm ? `${fighter.leg_reach_cm} cm` : "—"}
      />
      <Row label={t("stance")} value={stanceLabel ?? "—"} />
      <Row
        label={t("dateOfBirth")}
        value={
          age != null ? (
            <>
              <span className="font-mono tabular">{dobDisplay}</span>
              <span className="ml-1.5 text-foreground-muted">
                · {t("age", { n: age })}
              </span>
            </>
          ) : (
            dobDisplay
          )
        }
      />
      <Row
        label={t("country")}
        value={
          fighter.country_code ? (
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="text-base leading-none">
                {flag}
              </span>
              <span>{cn_label ?? fighter.country_code}</span>
            </span>
          ) : (
            "—"
          )
        }
      />
      {fighter.fighting_out_of ? (
        <Row label={t("outOf")} value={fighter.fighting_out_of} />
      ) : null}
    </dl>
  );
}
