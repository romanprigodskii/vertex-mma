import type { FighterDetail } from "@/lib/fighter-detail";
import { getCountryFlag } from "@/lib/fighter-helpers";

const STANCE_LABEL: Record<string, string> = {
  orthodox: "Orthodox",
  southpaw: "Southpaw",
  switch: "Switch",
  sideways: "Sideways",
  unknown: "Unknown",
};

// Lazy-init the formatter once.
let regionFormatter: Intl.DisplayNames | null = null;
function countryName(code: string | null): string | null {
  if (!code) return null;
  if (!regionFormatter) {
    try {
      regionFormatter = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      return code;
    }
  }
  return regionFormatter.of(code) ?? code;
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

export function PhysicalInfo({ fighter }: PhysicalInfoProps) {
  const { display: dobDisplay, age } = formatDob(fighter.dob);
  const cn_label = countryName(fighter.country_code);
  const flag = getCountryFlag(fighter.country_code);
  const stanceLabel = fighter.stance
    ? STANCE_LABEL[fighter.stance] ?? fighter.stance
    : null;

  return (
    <dl className="flex flex-col">
      <Row
        label="Height"
        value={fighter.height_cm ? `${fighter.height_cm} cm` : "—"}
      />
      <Row
        label="Reach"
        value={fighter.reach_cm ? `${fighter.reach_cm} cm` : "—"}
      />
      <Row
        label="Leg reach"
        value={fighter.leg_reach_cm ? `${fighter.leg_reach_cm} cm` : "—"}
      />
      <Row label="Stance" value={stanceLabel ?? "—"} />
      <Row
        label="Date of birth"
        value={
          age != null ? (
            <>
              <span className="font-mono tabular">{dobDisplay}</span>
              <span className="ml-1.5 text-foreground-muted">· age {age}</span>
            </>
          ) : (
            dobDisplay
          )
        }
      />
      <Row
        label="Country"
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
        <Row label="Out of" value={fighter.fighting_out_of} />
      ) : null}
    </dl>
  );
}
