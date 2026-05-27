"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Coins, LogOut, Menu, Moon, Sun, X } from "lucide-react";
import { useTheme } from "next-themes";

import type { CurrentUser } from "@/lib/auth";
import { NAV_SECTIONS } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export function MobileNav({ user }: { user: CurrentUser | null }) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  // Close the drawer whenever the route changes underneath us.
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const isLight = resolvedTheme === "light";

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Open menu"
          className="md:hidden rounded-sm p-1.5 text-foreground-muted transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
        >
          <Menu className="h-5 w-5" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-background-base/85 backdrop-blur md:hidden" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-80 max-w-[85vw] flex-col border-l border-foreground/10 bg-background-elevated md:hidden"
        >
          <div className="flex items-center justify-between border-b border-foreground/10 p-4">
            <Dialog.Title className="font-display text-base uppercase tracking-widest text-foreground">
              Menu
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label="Close menu"
                className="rounded-sm p-1.5 text-foreground-muted hover:bg-foreground/[0.05]"
              >
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>

          <nav className="flex-1 overflow-y-auto p-4">
            <ul className="flex flex-col gap-1">
              {NAV_SECTIONS.map((s) => {
                const active =
                  pathname === s.href || pathname.startsWith(`${s.href}/`);
                return (
                  <li key={s.href}>
                    <Link
                      href={s.href}
                      className={cn(
                        "block rounded-sm px-3 py-2.5 font-sans text-base uppercase tracking-widest transition-colors",
                        active
                          ? "bg-foreground/[0.06] text-foreground"
                          : "text-foreground-muted hover:bg-foreground/[0.04] hover:text-foreground",
                      )}
                    >
                      {s.label}
                    </Link>
                  </li>
                );
              })}
            </ul>

            <hr className="my-4 border-foreground/10" />

            <button
              type="button"
              onClick={() => setTheme(isLight ? "dark" : "light")}
              className="mb-3 flex w-full items-center gap-2.5 rounded-sm border border-foreground/15 px-3 py-2.5 text-left font-sans text-sm text-foreground transition-colors hover:bg-foreground/[0.04]"
            >
              {mounted ? (
                isLight ? (
                  <Moon className="h-4 w-4" aria-hidden />
                ) : (
                  <Sun className="h-4 w-4" aria-hidden />
                )
              ) : (
                <Sun className="h-4 w-4 opacity-0" aria-hidden />
              )}
              <span className="uppercase tracking-widest">
                {mounted
                  ? isLight
                    ? "Switch to dark"
                    : "Switch to light"
                  : "Theme"}
              </span>
            </button>

            {user ? (
              <>
                <div className="mb-3 flex items-center gap-2 rounded-sm bg-background-base/40 px-3 py-2">
                  <Coins className="h-4 w-4 text-gold" aria-hidden />
                  <span className="font-sans text-sm tabular text-foreground">
                    {user.balanceCoins.toLocaleString()}
                  </span>
                  <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                    {user.tier}
                  </span>
                </div>
                <ul className="flex flex-col gap-1">
                  <li>
                    <Link
                      href={`/profile/${user.username}`}
                      className="block rounded-sm px-3 py-2 font-sans text-sm text-foreground hover:bg-foreground/[0.04]"
                    >
                      Profile
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/me/bets"
                      className="block rounded-sm px-3 py-2 font-sans text-sm text-foreground hover:bg-foreground/[0.04]"
                    >
                      My bets
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/me/predictions"
                      className="block rounded-sm px-3 py-2 font-sans text-sm text-foreground hover:bg-foreground/[0.04]"
                    >
                      My predictions
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/notifications"
                      className="block rounded-sm px-3 py-2 font-sans text-sm text-foreground hover:bg-foreground/[0.04]"
                    >
                      Notifications
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/settings"
                      className="block rounded-sm px-3 py-2 font-sans text-sm text-foreground hover:bg-foreground/[0.04]"
                    >
                      Settings
                    </Link>
                  </li>
                  <li className="mt-2">
                    <form action="/auth/signout" method="post">
                      <button
                        type="submit"
                        className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left font-sans text-sm text-streak-loss hover:bg-streak-loss/10"
                      >
                        <LogOut className="h-4 w-4" />
                        Sign out
                      </button>
                    </form>
                  </li>
                </ul>
              </>
            ) : (
              <div className="flex flex-col gap-2">
                <Link
                  href="/signin"
                  className="rounded-sm bg-primary px-3 py-2 text-center font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
                >
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className="rounded-sm border border-foreground/15 px-3 py-2 text-center font-display text-sm uppercase tracking-widest text-foreground hover:bg-foreground/[0.05]"
                >
                  Create account
                </Link>
              </div>
            )}
          </nav>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
