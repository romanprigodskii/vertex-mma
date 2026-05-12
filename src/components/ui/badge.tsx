import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border font-medium uppercase tracking-wide whitespace-nowrap",
  {
    variants: {
      variant: {
        default:
          "border-border bg-background-elevated text-foreground-muted",
        primary:
          "border-transparent bg-primary text-primary-foreground",
        gold: "border-transparent bg-gold text-gold-foreground",
        success: "border-transparent bg-success/15 text-success",
        danger: "border-transparent bg-danger/15 text-danger",
        outline: "border-border-strong bg-transparent text-foreground",
        // Tier variants — subtle gradient using the tier token
        "tier-bronze":
          "border-transparent bg-gradient-to-br from-tier-bronze to-tier-bronze/70 text-foreground",
        "tier-silver":
          "border-transparent bg-gradient-to-br from-tier-silver to-tier-silver/70 text-background-base",
        "tier-gold":
          "border-transparent bg-gradient-to-br from-tier-gold to-tier-gold/70 text-gold-foreground",
        "tier-diamond":
          "border-transparent bg-gradient-to-br from-tier-diamond to-tier-diamond/70 text-background-base",
        "tier-champion":
          "border-transparent bg-gradient-to-br from-tier-champion to-tier-champion/70 text-foreground",
      },
      size: {
        sm: "h-5 px-1.5 text-[10px]",
        default: "h-6 px-2 text-xs",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return (
    <span
      className={cn(badgeVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
export type { BadgeProps };
