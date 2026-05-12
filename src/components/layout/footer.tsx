import * as React from "react";
import Link from "next/link";
import { Globe, Mail, MessageCircle } from "lucide-react";

import { Container } from "@/components/layout/container";

const COLUMNS: Array<{ title: string; links: Array<{ href: string; label: string }> }> = [
  {
    title: "Product",
    links: [
      { href: "#fighters", label: "Fighters" },
      { href: "#simulator", label: "Simulator" },
      { href: "#markets", label: "Markets" },
      { href: "#cards", label: "Fight Cards" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "#about", label: "About" },
      { href: "#sources", label: "Data sources" },
      { href: "#contact", label: "Contact" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "#privacy", label: "Privacy" },
      { href: "#terms", label: "Terms" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border bg-background-base mt-24">
      <Container size="xl" className="py-12">
        <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
          <div className="col-span-2 md:col-span-1">
            <div className="font-display text-2xl tracking-wider">
              <span className="text-primary">V</span>
              <span className="text-foreground">ERTEX</span>
              <span className="text-foreground-muted text-base ml-2 align-middle font-sans tracking-normal">
                MMA
              </span>
            </div>
            <p className="mt-3 text-sm text-foreground-muted max-w-xs">
              AI-powered MMA fight simulator. Run any matchup, predict any fight.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <Link
                href="#"
                aria-label="Community"
                className="text-foreground-subtle hover:text-foreground transition-colors"
              >
                <MessageCircle className="h-5 w-5" />
              </Link>
              <Link
                href="#"
                aria-label="Website"
                className="text-foreground-subtle hover:text-foreground transition-colors"
              >
                <Globe className="h-5 w-5" />
              </Link>
              <Link
                href="#"
                aria-label="Contact"
                className="text-foreground-subtle hover:text-foreground transition-colors"
              >
                <Mail className="h-5 w-5" />
              </Link>
            </div>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.title}>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground-subtle">
                {col.title}
              </h4>
              <ul className="mt-3 space-y-2">
                {col.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-foreground-muted hover:text-foreground transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 pt-6 border-t border-border flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <p className="text-xs text-foreground-subtle">
            © 2025 Vertex MMA. All rights reserved.
          </p>
          <p className="text-xs text-foreground-subtle max-w-xl md:text-right">
            Virtual currency on Vertex MMA has no monetary value and cannot be
            exchanged for real money. For entertainment purposes only.
          </p>
        </div>
      </Container>
    </footer>
  );
}
