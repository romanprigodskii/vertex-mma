import Link from "next/link";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { PredictionEventCard } from "@/components/predictions/prediction-event-card";
import { getCurrentUser } from "@/lib/auth";
import { listOpenPredictionEvents } from "@/lib/predictions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Predictions",
  description: "Pick winners for upcoming UFC cards. Free to play.",
};

export default async function PredictionsListPage() {
  const [events, user] = await Promise.all([
    listOpenPredictionEvents(20),
    getCurrentUser(),
  ]);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
                Community
              </p>
              <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
                Predictions
              </h1>
              <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
                Pick winners for every fight on upcoming cards. 10 points per
                correct call. Free — no coins required.
              </p>
            </div>
            {user ? (
              <Link
                href="/me/predictions"
                className="rounded-sm border border-foreground/15 px-4 py-2 font-display text-sm uppercase tracking-widest text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
              >
                My predictions
              </Link>
            ) : (
              <Link
                href="/signin?next=/predictions"
                className="rounded-sm border border-foreground/15 px-4 py-2 font-display text-sm uppercase tracking-widest text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
              >
                Sign in to predict
              </Link>
            )}
          </header>

          {events.length === 0 ? (
            <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
              <p className="font-display text-2xl uppercase tracking-tight text-foreground">
                No open prediction events
              </p>
              <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                Prediction events open about two weeks before each UFC card.
                Check back when the next event is announced.
              </p>
              <Link
                href="/events"
                className="mt-6 inline-block rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
              >
                Browse upcoming events →
              </Link>
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {events.map((e) => (
                <li key={e.id}>
                  <PredictionEventCard event={e} />
                </li>
              ))}
            </ul>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}
