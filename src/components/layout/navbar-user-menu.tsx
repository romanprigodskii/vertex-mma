"use client";

import * as React from "react";
import Link from "next/link";
import {
  Coins,
  ListChecks,
  LogOut,
  Settings as SettingsIcon,
  UserCircle,
} from "lucide-react";

import type { CurrentUser } from "@/lib/auth";
import { formatCoins } from "@/lib/utils";

export function NavbarUserMenu({ user }: { user: CurrentUser }) {
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
        className="inline-flex h-9 items-center gap-2 rounded-md border border-edge bg-surface-elevated px-1.5 pr-3 text-fg-muted transition-colors duration-(--motion-fast) ease-out-soft hover:border-edge-strong hover:text-fg"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-fg/10 type-display text-[11px] text-fg">
          {initials}
        </span>
        <span className="type-body hidden max-w-[8rem] truncate text-sm text-fg sm:inline">
          {user.username}
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-edge bg-surface-elevated p-1 shadow-lg"
        >
          <div className="px-2 py-1.5">
            <p className="type-body truncate text-sm text-fg">
              {user.displayName ?? user.username}
            </p>
            <p className="type-meta truncate text-[10px] text-fg-subtle">
              @{user.username}
            </p>
          </div>
          <div className="mx-1 my-1 flex items-center gap-1.5 rounded-sm bg-surface-base/40 px-2 py-1.5">
            <Coins className="h-4 w-4 text-fg" aria-hidden />
            <span className="type-num text-sm text-fg">
              {formatCoins(user.balanceCoins)}
            </span>
            <span className="type-meta ml-auto text-[9px] text-fg-subtle">
              {user.tier}
            </span>
          </div>
          <Link
            href={`/profile/${user.username}`}
            onClick={() => setOpen(false)}
            className="type-body flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-fg transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.05]"
          >
            <UserCircle className="h-4 w-4" />
            Profile
          </Link>
          <Link
            href="/me/bets"
            onClick={() => setOpen(false)}
            className="type-body flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-fg transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.05]"
          >
            <Coins className="h-4 w-4" />
            My bets
          </Link>
          <Link
            href="/me/predictions"
            onClick={() => setOpen(false)}
            className="type-body flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-fg transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.05]"
          >
            <ListChecks className="h-4 w-4" />
            My predictions
          </Link>
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className="type-body flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-fg transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.05]"
          >
            <SettingsIcon className="h-4 w-4" />
            Settings
          </Link>
          <hr className="my-1 border-edge" />
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="type-body flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-fg transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.05]"
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
