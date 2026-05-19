"use client";

import * as React from "react";
import Link from "next/link";

import { Container } from "@/components/layout/container";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    console.error("ErrorBoundary:", error);
  }, [error]);

  return (
    <main className="flex-1">
      <Container size="md" className="py-20 text-center md:py-32">
        <p className="font-display text-8xl leading-none tabular text-streak-loss">
          500
        </p>
        <h1 className="mt-6 font-display text-4xl uppercase tracking-tight text-foreground">
          Something broke
        </h1>
        <p className="mx-auto mt-4 max-w-md font-sans text-base text-foreground-muted">
          Hit an unexpected error rendering this page. We&rsquo;ve logged it.
          Try again, or head somewhere else.
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-[10px] text-foreground-subtle">
            Error ID: {error.digest}
          </p>
        ) : null}
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-sm bg-primary px-5 py-2.5 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
          >
            Try again
          </button>
          <Link
            href="/"
            className="rounded-sm border border-foreground/15 px-5 py-2.5 font-display text-sm uppercase tracking-widest text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
          >
            Home
          </Link>
        </div>
      </Container>
    </main>
  );
}
