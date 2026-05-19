import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { getCurrentUser } from "@/lib/auth";
import { listMyPredictions } from "@/lib/predictions";

export const dynamic = "force-dynamic";

export const metadata = { title: "My predictions" };

export default async function MyPredictionsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/me/predictions");
  const rows = await listMyPredictions(user.userProfileId);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href="/predictions"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> Predictions
            </Link>
          </Container>
        </div>

        <Container size="lg" className="py-10 md:py-14">
          <h1 className="font-display uppercase tracking-tight text-foreground text-h1">
            My predictions
          </h1>

          {rows.length === 0 ? (
            <div className="mt-10 rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
              <p className="font-display text-2xl uppercase tracking-tight text-foreground">
                No picks yet
              </p>
              <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                Predict the next card to climb the leaderboard. 10 points per
                correct call — free, no coins needed.
              </p>
              <Link
                href="/predictions"
                className="mt-6 inline-block rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                Browse open events →
              </Link>
            </div>
          ) : (
            <ul className="mt-8 flex flex-col gap-2">
              {rows.map((r) => (
                <li key={r.prediction_event_id}>
                  <Link
                    href={`/predictions/${r.prediction_event_id}`}
                    prefetch={false}
                    className="block rounded-md border border-foreground/10 bg-background-elevated/30 p-3 hover:bg-foreground/[0.04]"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-sans text-sm text-foreground">
                          {r.event_name}
                        </p>
                        <p className="mt-0.5 font-mono text-[11px] tabular text-foreground-subtle">
                          {new Date(r.event_date).toLocaleDateString(
                            "en-US",
                            {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            },
                          )}{" "}
                          · {r.picks_count} pick
                          {r.picks_count === 1 ? "" : "s"}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        {r.status === "resolved" ? (
                          <p className="font-display text-lg tabular text-foreground">
                            {r.correct_count}/{r.picks_count}
                          </p>
                        ) : (
                          <p className="font-mono text-xs text-foreground-subtle">
                            Pending
                          </p>
                        )}
                        <p className="font-mono text-[10px] tabular text-foreground-subtle">
                          {r.total_points} pts
                        </p>
                      </div>
                    </div>
                  </Link>
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
