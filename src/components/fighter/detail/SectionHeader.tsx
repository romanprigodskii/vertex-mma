interface SectionHeaderProps {
  label: string;
  explainer?: string;
}

/**
 * Tiny header for fighter-detail sections. Left: small uppercase label,
 * right: one-line explainer text. Together they replace the heavier
 * "divider + title" pattern from earlier waves.
 */
export function SectionHeader({ label, explainer }: SectionHeaderProps) {
  return (
    <header className="mb-5 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
      <h2 className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
        {label}
      </h2>
      {explainer ? (
        <p className="max-w-prose font-sans text-[11px] text-foreground-subtle">
          {explainer}
        </p>
      ) : null}
    </header>
  );
}
