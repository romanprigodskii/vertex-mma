"use client";

import * as React from "react";
import Link from "next/link";
import {
  Coins,
  LogOut,
  Menu,
  Search,
  Settings as SettingsIcon,
  User,
  UserCircle,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Container } from "@/components/layout/container";
import type { CurrentUser } from "@/lib/auth";
import { cn } from "@/lib/utils";

const NAV_LINKS = [
  { href: "#fighters", label: "Fighters" },
  { href: "#events", label: "Events" },
  { href: "#simulator", label: "Simulator" },
  { href: "#markets", label: "Markets" },
  { href: "#cards", label: "Cards" },
  { href: "#news", label: "News" },
];

function Logo({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn(
        "font-display text-3xl tracking-wider leading-none select-none",
        className,
      )}
      aria-label="Vertex MMA — home"
    >
      <span className="text-primary">V</span>
      <span className="text-foreground">ERTEX</span>
    </Link>
  );
}

function UserMenu({ user }: { user: CurrentUser }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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
        className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background-elevated px-1.5 pr-3 text-foreground-muted hover:text-foreground hover:border-border-strong transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 font-display text-[11px] uppercase text-primary">
          {initials}
        </span>
        <span className="hidden sm:inline font-sans text-sm text-foreground max-w-[8rem] truncate">
          {user.username}
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-52 rounded-md border border-border bg-background-elevated p-1 shadow-lg"
        >
          <div className="px-2 py-1.5">
            <p className="font-sans text-sm text-foreground truncate">
              {user.displayName ?? user.username}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle truncate">
              @{user.username}
            </p>
          </div>
          <div className="mx-1 my-1 flex items-center gap-1.5 rounded-sm bg-background-base/40 px-2 py-1.5">
            <Coins className="h-4 w-4 text-gold" />
            <span className="font-sans text-sm text-foreground tabular">
              {user.balanceCoins.toLocaleString()}
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
            Profile
          </Link>
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-sm px-2 py-1.5 font-sans text-sm text-foreground hover:bg-foreground/[0.05]"
          >
            <SettingsIcon className="h-4 w-4" />
            Settings
          </Link>
          <hr className="my-1 border-foreground/10" />
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-sans text-sm text-foreground hover:bg-foreground/[0.05]"
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

export function NavbarInner({ user }: { user: CurrentUser | null }) {
  const [mobileOpen, setMobileOpen] = React.useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background-base/80 backdrop-blur-md">
      <Container size="xl">
        <div className="flex h-16 items-center justify-between gap-4">
          {/* Mobile menu trigger */}
          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            className="md:hidden inline-flex h-10 w-10 items-center justify-center rounded-md text-foreground-muted hover:text-foreground hover:bg-background-elevated transition-colors"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>

          {/* Logo */}
          <div className="md:flex-none flex-1 flex justify-center md:justify-start">
            <Logo />
          </div>

          {/* Center nav */}
          <nav className="hidden md:flex items-center gap-1">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="px-3 py-2 text-sm font-medium text-foreground-muted hover:text-foreground transition-colors rounded-md"
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Right cluster */}
          <div className="flex items-center gap-1 sm:gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Search"
              className="hidden sm:inline-flex"
            >
              <Search className="h-4 w-4" />
            </Button>

            {user ? (
              <>
                <div className="hidden sm:inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-background-elevated text-sm tabular">
                  <Coins className="h-4 w-4 text-gold" />
                  <span className="text-foreground-muted">
                    {user.balanceCoins.toLocaleString()}
                  </span>
                </div>
                <UserMenu user={user} />
              </>
            ) : (
              <Link
                href="/signin"
                className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-background-elevated px-3 font-sans text-sm text-foreground-muted hover:text-foreground hover:border-border-strong transition-colors"
              >
                <User className="h-4 w-4" />
                <span className="hidden sm:inline">Sign in</span>
              </Link>
            )}
          </div>
        </div>

        {/* Mobile drawer */}
        {mobileOpen && (
          <div className="md:hidden border-t border-border py-2">
            <nav className="flex flex-col">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className="px-3 py-3 text-sm font-medium text-foreground-muted hover:text-foreground hover:bg-background-elevated rounded-md transition-colors"
                >
                  {link.label}
                </Link>
              ))}
              {user ? (
                <div className="mt-2 pt-2 border-t border-border flex items-center gap-2 px-3 py-2 sm:hidden">
                  <Coins className="h-4 w-4 text-gold" />
                  <span className="text-sm text-foreground-muted tabular">
                    {user.balanceCoins.toLocaleString()}
                  </span>
                </div>
              ) : (
                <Link
                  href="/signup"
                  onClick={() => setMobileOpen(false)}
                  className="mt-2 pt-2 border-t border-border px-3 py-3 text-sm font-medium text-primary hover:underline sm:hidden"
                >
                  Create account
                </Link>
              )}
            </nav>
          </div>
        )}
      </Container>
    </header>
  );
}
