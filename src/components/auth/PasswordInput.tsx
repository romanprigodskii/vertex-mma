"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Eye, EyeOff } from "lucide-react";

import { cn } from "@/lib/utils";

type PasswordInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
>;

export function PasswordInput({ className, ...rest }: PasswordInputProps) {
  const t = useTranslations("auth");
  const [visible, setVisible] = React.useState(false);

  return (
    <div className="relative">
      <input
        type={visible ? "text" : "password"}
        {...rest}
        className={cn(
          "w-full rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 pr-10 font-sans text-sm text-foreground focus:border-primary focus:outline-none",
          className,
        )}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? t("hidePassword") : t("showPassword")}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 flex items-center px-2.5 text-foreground-muted hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
      >
        {visible ? (
          <EyeOff className="h-4 w-4" aria-hidden="true" />
        ) : (
          <Eye className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
