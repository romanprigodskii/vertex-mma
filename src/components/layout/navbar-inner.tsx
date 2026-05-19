import Link from "next/link";
import { Coins } from "lucide-react";

import { Container } from "@/components/layout/container";
import { MobileNav } from "@/components/layout/mobile-nav";
import { NavSections } from "@/components/layout/nav-sections";
import { NavbarNotifications } from "@/components/layout/navbar-notifications";
import { NavbarUserMenu } from "@/components/layout/navbar-user-menu";
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

export function NavbarInner({
  user,
  unreadCount,
  recentNotifications,
}: Props) {
  return (
    <header className="sticky top-0 z-40 border-b border-foreground/[0.06] bg-background-base/85 backdrop-blur-md">
      <Container size="xl">
        <div className="flex h-14 items-center justify-between gap-4 md:h-16 md:gap-6">
          <Logo />
          <NavSections />
          <div className="flex items-center gap-2">
            {user ? (
              <>
                <div className="hidden h-9 items-center gap-1.5 rounded-md border border-foreground/15 bg-background-elevated px-3 text-sm tabular sm:inline-flex">
                  <Coins className="h-4 w-4 text-gold" aria-hidden />
                  <span className="text-foreground-muted">
                    {user.balanceCoins.toLocaleString()}
                  </span>
                </div>
                <NavbarNotifications
                  unreadCount={unreadCount}
                  recent={recentNotifications}
                />
                <NavbarUserMenu user={user} />
              </>
            ) : (
              <Link
                href="/signin"
                className="hidden font-sans text-sm uppercase tracking-widest text-foreground-muted transition-colors hover:text-foreground md:inline"
              >
                Sign in
              </Link>
            )}
            <MobileNav user={user} />
          </div>
        </div>
      </Container>
    </header>
  );
}
