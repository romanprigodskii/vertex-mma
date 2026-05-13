import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium",
    "transition-all duration-150 ease-out",
    "hover:scale-[1.02] active:scale-[0.98]",
    "disabled:pointer-events-none disabled:opacity-50 disabled:hover:scale-100",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background-base",
    "[&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary-hover shadow-elevation-1",
        gold: "bg-gold text-gold-foreground hover:brightness-110 shadow-elevation-1",
        outline:
          "border border-border-strong bg-transparent text-foreground hover:bg-background-elevated",
        ghost: "bg-transparent text-foreground hover:bg-background-elevated",
        danger:
          "bg-danger text-danger-foreground hover:brightness-110 shadow-elevation-1",
        link: "text-primary underline-offset-4 hover:underline hover:scale-100 active:scale-100 p-0 h-auto",
      },
      size: {
        sm: "h-8 rounded-md px-3 text-sm",
        default: "h-10 rounded-md px-4 text-sm",
        lg: "h-12 rounded-md px-6 text-base",
        xl: "h-14 rounded-md px-8 text-lg",
        icon: "h-10 w-10 rounded-md",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild = false, loading, disabled, children, ...props },
    ref,
  ) => {
    const Comp = asChild ? Slot : "button";
    const isDisabled = disabled || loading;

    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={isDisabled}
        {...props}
      >
        {loading ? (
          <>
            <Loader2 className="animate-spin" />
            {children}
          </>
        ) : (
          children
        )}
      </Comp>
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
export type { ButtonProps };
