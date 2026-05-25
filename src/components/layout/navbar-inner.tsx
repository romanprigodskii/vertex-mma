import Link from "next/link";
import { Coins } from "lucide-react";

import { Container } from "@/components/layout/container";
import { MobileNav } from "@/components/layout/mobile-nav";
import { NavSections } from "@/components/layout/nav-sections";
import { NavbarNotifications } from "@/components/layout/navbar-notifications";
import { NavbarSearch } from "@/components/layout/navbar-search";
import { NavbarUserMenu } from "@/components/layout/navbar-user-menu";
import type { CurrentUser } from "@/lib/auth";
import type { NotificationRow } from "@/lib/notifications";
import { formatCoins } from "@/lib/utils";

interface Props {
  user: CurrentUser | null;
  unreadCount: number;
  recentNotifications: NotificationRow[];
}

function Logo() {
  return (
    <Link
      href="/"
      className="select-none font-broadcast-display text-2xl font-bold uppercase leading-none tracking-wider text-fg"
      aria-label="Vertex MMA — home"
    >
      VERTEX
    </Link>
  );
}

export function NavbarInner({
  user,
  unreadCount,
  recentNotifications,
}: Props) {
  return (
    <header className="sticky top-0 z-40 border-b border-fg/[0.06] bg-surface-base/85 backdrop-blur-md">
      <Container size="xl">
        <div className="flex h-14 items-center justify-between gap-4 md:h-16 md:gap-6">
          <Logo />
          <NavSections />
          <div className="flex items-center gap-2">
            <NavbarSearch />
            {user ? (
              <>
                <div className="hidden h-9 items-center gap-1.5 rounded-md border border-edge bg-surface-elevated px-3 type-num text-sm sm:inline-flex">
                  <Coins className="h-4 w-4 text-fg" aria-hidden />
                  <span className="text-fg">
                    {formatCoins(user.balanceCoins)}
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
                className="type-label hidden text-sm text-fg-muted transition-colors duration-(--motion-fast) ease-out-soft hover:text-fg md:inline"
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
