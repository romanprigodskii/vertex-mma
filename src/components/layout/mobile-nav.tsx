"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Coins, LogOut, Menu, X } from "lucide-react";

import type { CurrentUser } from "@/lib/auth";
import { NAV_SECTIONS } from "@/lib/navigation";
import { cn, formatCoins } from "@/lib/utils";

export function MobileNav({ user }: { user: CurrentUser | null }) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();

  // Close the drawer whenever the route changes underneath us.
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Open menu"
          className="md:hidden rounded-sm p-1.5 text-fg-muted transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.05] hover:text-fg"
        >
          <Menu className="h-5 w-5" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-surface-base/85 backdrop-blur md:hidden" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 flex w-80 max-w-[85vw] flex-col border-l border-edge bg-surface-elevated md:hidden"
        >
          <div className="flex items-center justify-between border-b border-edge p-4">
            <Dialog.Title className="type-label text-base text-fg">
              Menu
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label="Close menu"
                className="rounded-sm p-1.5 text-fg-muted transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.05]"
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
                        "type-label block rounded-sm px-3 py-2.5 text-base transition-colors duration-(--motion-fast) ease-out-soft",
                        active
                          ? "bg-fg/[0.06] text-fg"
                          : "text-fg-muted hover:bg-fg/[0.04] hover:text-fg",
                      )}
                    >
                      {s.label}
                    </Link>
                  </li>
                );
              })}
            </ul>

            <hr className="my-4 border-edge" />

            {user ? (
              <>
                <div className="mb-3 flex items-center gap-2 rounded-sm bg-surface-base/40 px-3 py-2">
                  <Coins className="h-4 w-4 text-fg-muted" aria-hidden />
                  <span className="type-num text-sm text-fg">
                    {formatCoins(user.balanceCoins)}
                  </span>
                  <span className="type-meta ml-auto text-[10px] text-fg-subtle">
                    {user.tier}
                  </span>
                </div>
                <ul className="flex flex-col gap-1">
                  <li>
                    <Link
                      href={`/profile/${user.username}`}
                      className="type-body block rounded-sm px-3 py-2 text-sm text-fg transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.04]"
                    >
                      Profile
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/me/bets"
                      className="type-body block rounded-sm px-3 py-2 text-sm text-fg transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.04]"
                    >
                      My bets
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/me/predictions"
                      className="type-body block rounded-sm px-3 py-2 text-sm text-fg transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.04]"
                    >
                      My predictions
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/notifications"
                      className="type-body block rounded-sm px-3 py-2 text-sm text-fg transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.04]"
                    >
                      Notifications
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/settings"
                      className="type-body block rounded-sm px-3 py-2 text-sm text-fg transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.04]"
                    >
                      Settings
                    </Link>
                  </li>
                  <li className="mt-2">
                    <form action="/auth/signout" method="post">
                      <button
                        type="submit"
                        className="type-body flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm text-loss transition-colors duration-(--motion-fast) ease-out-soft hover:bg-loss/10"
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
                  className="type-label rounded-sm bg-accent px-3 py-2 text-center text-sm text-accent-foreground transition-colors duration-(--motion-fast) ease-out-soft hover:bg-accent-hover"
                >
                  Sign in
                </Link>
                <Link
                  href="/signup"
                  className="type-label rounded-sm border border-edge px-3 py-2 text-center text-sm text-fg transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.05]"
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
