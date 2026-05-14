import { SectionHeader } from "@/components/fighter/detail/SectionHeader";
import { Container } from "@/components/layout/container";
import { cn } from "@/lib/utils";

interface CompareSectionProps {
  label: string;
  explainer?: string;
  meta?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function CompareSection({
  label,
  explainer,
  meta,
  className,
  children,
}: CompareSectionProps) {
  return (
    <section className={cn("mt-4 sm:mt-8", className)}>
      <Container size="xl">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <SectionHeader label={label} explainer={explainer} />
          {meta ? (
            <div className="ml-auto font-mono text-[11px] tabular text-foreground-subtle">
              {meta}
            </div>
          ) : null}
        </div>
        {children}
      </Container>
    </section>
  );
}
