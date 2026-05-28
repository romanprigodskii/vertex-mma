"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { Container } from "@/components/layout/container";
import { Link } from "@/i18n/navigation";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("error");
  const router = useRouter();

  React.useEffect(() => {
    console.error("ErrorBoundary:", error);
  }, [error]);

  // App Router's `reset()` only re-renders the error boundary on the
  // client — it doesn't refetch server data. When the error came from a
  // server query (DB timeout, pool exhaustion, etc.), reset alone leaves
  // the stale failed state in place. Pair it with router.refresh() to
  // invalidate the server-component cache so the next render actually
  // re-runs the data fetch.
  const handleRetry = React.useCallback(() => {
    router.refresh();
    reset();
  }, [router, reset]);

  return (
    <main className="flex-1">
      <Container size="md" className="py-20 text-center md:py-32">
        <p className="font-display text-8xl leading-none tabular text-streak-loss">
          {t("code")}
        </p>
        <h1 className="mt-6 font-display text-4xl uppercase tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="mx-auto mt-4 max-w-md font-sans text-base text-foreground-muted">
          {t("lead")}
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-[10px] text-foreground-subtle">
            {t("errorId", { id: error.digest })}
          </p>
        ) : null}
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={handleRetry}
            className="rounded-sm bg-primary px-5 py-2.5 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
          >
            {t("tryAgain")}
          </button>
          <Link
            href="/"
            className="rounded-sm border border-foreground/15 px-5 py-2.5 font-display text-sm uppercase tracking-widest text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
          >
            {t("home")}
          </Link>
        </div>
      </Container>
    </main>
  );
}
