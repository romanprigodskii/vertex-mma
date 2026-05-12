"use client";

import * as React from "react";
import Link from "next/link";
import { Coins, Menu, Search, User, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Container } from "@/components/layout/container";
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

export function Navbar() {
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

            <div className="hidden sm:inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-border bg-background-elevated text-sm tabular">
              <Coins className="h-4 w-4 text-gold" />
              <span className="text-foreground-muted">0</span>
            </div>

            <button
              type="button"
              className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background-elevated text-foreground-muted hover:text-foreground hover:border-border-strong transition-colors"
              aria-label="Account"
            >
              <User className="h-4 w-4" />
            </button>
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
              <div className="mt-2 pt-2 border-t border-border flex items-center gap-2 px-3 py-2 sm:hidden">
                <Coins className="h-4 w-4 text-gold" />
                <span className="text-sm text-foreground-muted tabular">0</span>
              </div>
            </nav>
          </div>
        )}
      </Container>
    </header>
  );
}
