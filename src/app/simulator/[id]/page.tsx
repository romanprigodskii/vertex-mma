import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { ShareButton } from "@/components/share/share-button";
import { SimulationResultView } from "@/components/simulator/simulation-result-view";
import { getSimulationById } from "@/lib/simulations";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const sim = await getSimulationById(id);
  if (!sim) return { title: "Simulation not found" };
  const title = `${sim.fighter_a.name_en} vs ${sim.fighter_b.name_en} · Simulator`;
  const desc = sim.result.mostLikelyScenario;
  const ogImage = `/api/og/simulations/${sim.id}`;
  return {
    title,
    description: desc,
    openGraph: {
      title,
      description: desc,
      siteName: "Vertex MMA",
      type: "article",
      images: [
        {
          url: ogImage,
          width: 1200,
          height: 630,
          alt: title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      images: [ogImage],
    },
  };
}

export default async function SimulationDetailPage({ params }: PageProps) {
  const { id } = await params;
  const sim = await getSimulationById(id);
  if (!sim) notFound();

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container
            size="xl"
            className="flex items-center justify-between py-3"
          >
            <Link
              href="/simulator"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> Simulator
            </Link>
            <ShareButton
              url={`/simulator/${sim.id}`}
              ogImageUrl={`/api/og/simulations/${sim.id}`}
              title={`${sim.fighter_a.name_en} vs ${sim.fighter_b.name_en} simulation`}
              filename={`vertexmma-sim-${sim.id.slice(0, 8)}`}
              label="Share simulation"
              variant="icon"
            />
          </Container>
        </div>

        <Container size="lg" className="py-10 md:py-14">
          <p className="mb-6 font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
            Simulation ·{" "}
            {new Date(sim.created_at).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
            {sim.author_username ? (
              <>
                {" "}
                ·{" "}
                <Link
                  href={`/profile/${sim.author_username}`}
                  className="hover:text-foreground"
                >
                  by @{sim.author_username}
                </Link>
              </>
            ) : null}
          </p>
          <SimulationResultView sim={sim} />
        </Container>
      </main>
      <Footer />
    </>
  );
}
