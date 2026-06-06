"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Coins, LogOut, Menu, Moon, Search, Sun, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useSearchParams } from "next/navigation";

import { openFighterSearch } from "@/components/search/fighter-search-palette";
import { useMounted } from "@/hooks/use-mounted";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import type { CurrentUser } from "@/lib/auth";
import { formatNumber } from "@/lib/format";
import { NAV_SECTIONS } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export function MobileNav({ user }: { user: CurrentUser | null }) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const locale = useLocale();
  const t = useTranslations("nav");
  const tUser = useTranslations("userMenu");
  const tSearch = useTranslations("search");
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useMounted();

  // Close the drawer whenever the route changes underneath us.
  React.useEffect(() => {
    setOpen(false);
  }, [pathname]);

  const isLight = resolvedTheme === "light";
  const otherLocale = locale === "ru" ? "en" : "ru";

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label={t("openMenu")}
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
              {t("menu")}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label={t("closeMenu")}
                className="rounded-sm p-1.5 text-foreground-muted hover:bg-foreground/[0.05]"
              >
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>

          <nav className="flex-1 overflow-y-auto p-4">
            <button
              type="button"
              onClick={() => {
                // Close the drawer, then open the global command palette. The
                // palette listens for this event from anywhere in the app, so
                // touch users (who can't reach Cmd/Ctrl+K) get search too.
                setOpen(false);
                openFighterSearch();
              }}
              className="mb-4 flex w-full items-center gap-2.5 rounded-sm border border-foreground/15 bg-background-base/40 px-3 py-2.5 text-left font-sans text-sm text-foreground-muted transition-colors hover:border-foreground/30 hover:bg-foreground/[0.04] hover:text-foreground"
            >
              <Search className="h-4 w-4" aria-hidden />
              <span className="uppercase tracking-widest">
                {tSearch("title")}
              </span>
            </button>

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
                      {t(s.labelKey)}
                    </Link>
                  </li>
                );
              })}
            </ul>

            <hr className="my-4 border-foreground/10" />

            <button
              type="button"
              onClick={() => {
                const qs = searchParams.toString();
                router.replace(`${pathname}${qs ? `?${qs}` : ""}`, {
                  locale: otherLocale as (typeof routing.locales)[number],
                });
              }}
              className="mb-3 flex w-full items-center gap-2.5 rounded-sm border border-foreground/15 px-3 py-2.5 text-left font-sans text-sm text-foreground transition-colors hover:bg-foreground/[0.04]"
            >
              <span className="inline-flex h-4 w-4 items-center justify-center rounded-sm border border-foreground/30 font-mono text-[9px] tracking-tighter">
                {otherLocale.toUpperCase()}
              </span>
              <span className="uppercase tracking-widest">
                {otherLocale === "ru" ? t("switchToRussian") : t("switchToEnglish")}
              </span>
            </button>

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
                    ? t("switchToDark")
                    : t("switchToLight")
                  : t("switchToLight")}
              </span>
            </button>

            {user ? (
              <>
                <div className="mb-3 flex items-center gap-2 rounded-sm bg-background-base/40 px-3 py-2">
                  <Coins className="h-4 w-4 text-gold" aria-hidden />
                  <span className="font-sans text-sm tabular text-foreground">
                    {formatNumber(user.balanceCoins)}
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
                      {tUser("profile")}
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/me/bets"
                      className="block rounded-sm px-3 py-2 font-sans text-sm text-foreground hover:bg-foreground/[0.04]"
                    >
                      {tUser("myBets")}
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/notifications"
                      className="block rounded-sm px-3 py-2 font-sans text-sm text-foreground hover:bg-foreground/[0.04]"
                    >
                      {tUser("notifications")}
                    </Link>
                  </li>
                  <li>
                    <Link
                      href="/settings"
                      className="block rounded-sm px-3 py-2 font-sans text-sm text-foreground hover:bg-foreground/[0.04]"
                    >
                      {tUser("settings")}
                    </Link>
                  </li>
                  <li className="mt-2">
                    <form action="/auth/signout" method="post">
                      <button
                        type="submit"
                        className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left font-sans text-sm text-streak-loss hover:bg-streak-loss/10"
                      >
                        <LogOut className="h-4 w-4" />
                        {tUser("signOut")}
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
                  {t("signIn")}
                </Link>
                <Link
                  href="/signup"
                  className="rounded-sm border border-foreground/15 px-3 py-2 text-center font-display text-sm uppercase tracking-widest text-foreground hover:bg-foreground/[0.05]"
                >
                  {t("signUp")}
                </Link>
              </div>
            )}
          </nav>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
