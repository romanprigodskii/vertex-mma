import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { Coins } from "lucide-react";

import { Container } from "@/components/layout/container";
import { LanguageToggle } from "@/components/layout/language-toggle";
import { MobileNav } from "@/components/layout/mobile-nav";
import { NavSections } from "@/components/layout/nav-sections";
import { NavbarNotifications } from "@/components/layout/navbar-notifications";
import { NavbarUserMenu } from "@/components/layout/navbar-user-menu";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { FighterSearchTrigger } from "@/components/search/fighter-search-palette";
import type { CurrentUser } from "@/lib/auth";
import type { NotificationRow } from "@/lib/notifications";

interface Props {
  user: CurrentUser | null;
  unreadCount: number;
  recentNotifications: NotificationRow[];
}

function Logo() {
  return (
    <Link
      href="/"
      className="select-none font-display text-2xl leading-none tracking-wider"
      aria-label="Vertex MMA — home"
    >
      <span className="text-primary">V</span>
      <span className="text-foreground">ERTEX</span>
    </Link>
  );
}

export async function NavbarInner({
  user,
  unreadCount,
  recentNotifications,
}: Props) {
  const t = await getTranslations("nav");
  return (
    <header className="sticky top-0 z-40 border-b border-foreground/[0.06] bg-background-base/85 backdrop-blur-md">
      <Container size="xl">
        <div className="flex h-14 items-center justify-between gap-4 md:h-16 md:gap-6">
          <Logo />
          <NavSections />
          <div className="flex items-center gap-2">
            <FighterSearchTrigger className="hidden lg:inline-flex" />
            <LanguageToggle className="hidden md:inline-flex" />
            <ThemeToggle className="hidden md:inline-flex" />
            {user ? (
              <>
                <div className="hidden h-9 items-center gap-1.5 rounded-md border border-foreground/15 bg-background-elevated px-3 text-sm tabular sm:inline-flex">
                  <Coins className="h-4 w-4 text-gold" aria-hidden />
                  <span className="text-foreground-muted">
                    {user.balanceCoins.toLocaleString()}
                  </span>
                </div>
                <NavbarNotifications
                  initialUnreadCount={unreadCount}
                  initialRecent={recentNotifications}
                />
                <NavbarUserMenu user={user} />
              </>
            ) : (
              <Link
                href="/signin"
                className="hidden font-sans text-sm uppercase tracking-widest text-foreground-muted transition-colors hover:text-foreground md:inline"
              >
                {t("signIn")}
              </Link>
            )}
            <MobileNav user={user} />
          </div>
        </div>
      </Container>
    </header>
  );
}
