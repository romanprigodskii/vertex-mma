import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { RankingForm } from "@/components/rankings/ranking-form";
import { getCurrentUser } from "@/lib/auth";
import { getRankingById } from "@/lib/rankings";

export const dynamic = "force-dynamic";

export const metadata = { title: "Edit ranking" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditRankingPage({ params }: PageProps) {
  const { id } = await params;
  const [ranking, user] = await Promise.all([
    getRankingById(id),
    getCurrentUser(),
  ]);
  if (!ranking) notFound();
  if (!user) redirect(`/signin?next=/rankings/${id}/edit`);
  if (user.userProfileId !== ranking.user_id) {
    redirect(`/rankings/${id}`);
  }

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href={`/rankings/${ranking.id}`}
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> Back to ranking
            </Link>
          </Container>
        </div>

        <Container size="lg" className="py-10 md:py-14">
          <header className="mb-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              Edit ranking
            </p>
            <h1 className="mt-2 font-display text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
              {ranking.title}
            </h1>
          </header>
          <RankingForm
            mode="edit"
            rankingId={ranking.id}
            initialTitle={ranking.title}
            initialDescription={ranking.description ?? ""}
            initialEntries={ranking.entries.map((e) => ({
              fighter_id: e.fighter_id,
              fighter_name: e.fighter_name,
              fighter_photo_thumbnail_url: e.fighter_photo_thumbnail_url,
              fighter_weight_class: e.fighter_weight_class,
              position: e.position,
              note: e.note ?? "",
            }))}
          />
        </Container>
      </main>
      <Footer />
    </>
  );
}
