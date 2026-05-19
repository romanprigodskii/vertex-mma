import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { SimulatorForm } from "@/components/simulator/simulator-form";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Fight Simulator",
  description:
    "Pick any two UFC fighters and get a rule-based prediction — winner probability, method, round, and the key factors driving the call.",
};

export default function SimulatorPage() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="lg" className="py-10 md:py-14">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
            What if
          </p>
          <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
            Fight Simulator
          </h1>
          <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
            Pick two fighters. The rule-based v1 simulator combines Vertex
            score, style matchup, defensive holes, and recent form into a
            predicted winner, method, and round. Saves and shares.
          </p>
          <div className="mt-10">
            <SimulatorForm />
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
