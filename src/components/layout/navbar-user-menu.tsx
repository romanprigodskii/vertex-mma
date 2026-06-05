"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  Coins,
  LogOut,
  Settings as SettingsIcon,
  ShieldCheck,
  UserCircle,
} from "lucide-react";

import { Link } from "@/i18n/navigation";
import type { CurrentUser } from "@/lib/auth";
import { formatNumber } from "@/lib/format";

export function NavbarUserMenu({ user }: { user: CurrentUser }) {
  const t = useTranslations("userMenu");
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const initials = user.username.slice(0, 2).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 items-center gap-2 rounded-md border border-foreground/15 bg-background-elevated px-1.5 pr-3 text-foreground-muted transition-colors hover:border-foreground/25 hover:text-foreground"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("accountMenu")}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 font-display text-[11px] uppercase text-primary">
          {initials}
        </span>
        <span className="hidden max-w-[8rem] truncate font-sans text-sm text-foreground sm:inline">
          {user.username}
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-foreground/15 bg-background-elevated p-1 shadow-lg"
        >
          <div className="px-2 py-1.5">
            <p className="truncate font-sans text-sm text-foreground">
              {user.displayName ?? user.username}
            </p>
            <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
              @{user.username}
            </p>
          </div>
          <div className="mx-1 my-1 flex items-center gap-1.5 rounded-sm bg-background-base/40 px-2 py-1.5">
            <Coins className="h-4 w-4 text-gold" aria-hidden />
            <span className="font-sans text-sm tabular text-foreground">
              {formatNumber(user.balanceCoins)}
            </span>
            <span className="ml-auto font-mono text-[9px] uppercase tracking-widest text-foreground-subtle">
              {user.tier}
            </span>
          </div>
          <Link
            href={`/profile/${user.username}`}
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-sm px-2 py-1.5 font-sans text-sm text-foreground hover:bg-foreground/[0.05]"
          >
            <UserCircle className="h-4 w-4" />
            {t("profile")}
          </Link>
          <Link
            href="/me/bets"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-sm px-2 py-1.5 font-sans text-sm text-foreground hover:bg-foreground/[0.05]"
          >
            <Coins className="h-4 w-4" />
            {t("myBets")}
          </Link>
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-sm px-2 py-1.5 font-sans text-sm text-foreground hover:bg-foreground/[0.05]"
          >
            <SettingsIcon className="h-4 w-4" />
            {t("settings")}
          </Link>
          {user.isStaff ? (
            <Link
              href="/admin/news"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 font-sans text-sm text-foreground hover:bg-foreground/[0.05]"
            >
              <ShieldCheck className="h-4 w-4 text-primary" />
              {t("moderation")}
            </Link>
          ) : null}
          <hr className="my-1 border-foreground/10" />
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-sans text-sm text-foreground hover:bg-foreground/[0.05]"
            >
              <LogOut className="h-4 w-4" />
              {t("signOut")}
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
