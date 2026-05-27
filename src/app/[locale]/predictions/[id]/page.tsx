import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { PredictionForm } from "@/components/predictions/prediction-form";
import { getCurrentUser } from "@/lib/auth";
import { getPredictionEventForUser } from "@/lib/predictions";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  const evt = await getPredictionEventForUser(id, user?.userProfileId ?? null);
  if (!evt) return { title: "Predictions not found" };
  return {
    title: `${evt.event_name} · Predictions`,
    description: `Pick winners for ${evt.event_name}. 10 points per correct call.`,
  };
}

export default async function PredictionDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/signin?next=/predictions/${id}`);

  const evt = await getPredictionEventForUser(id, user.userProfileId);
  if (!evt) notFound();

  const closed =
    evt.status !== "upcoming" ||
    new Date(evt.closes_at).getTime() <= Date.now();
  const closesLabel = new Date(evt.closes_at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

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
              <ChevronLeft className="h-4 w-4" aria-hidden /> All predictions
            </Link>
          </Container>
        </div>

        <Container size="lg" className="py-10 md:py-14">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
            {new Date(evt.event_date).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
          <h1 className="mt-3 font-display uppercase tracking-tight text-foreground text-h1">
            {evt.event_name}
          </h1>
          <p className="mt-2 font-sans text-sm text-foreground-muted">
            {closed ? "Predictions closed." : `Closes ${closesLabel}.`} ·{" "}
            {evt.total_participants} participant
            {evt.total_participants === 1 ? "" : "s"}
          </p>

          <div className="mt-8">
            <PredictionForm
              predictionEventId={evt.id}
              bouts={evt.bouts}
              readOnly={closed}
            />
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
