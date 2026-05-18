import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export const metadata = { title: "About" };

export default function AboutPage() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-16 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
            Vertex MMA
          </p>
          <h1 className="mt-3 font-display uppercase tracking-tight text-foreground text-h1">
            About
          </h1>
          <p className="mt-6 font-sans text-sm text-foreground-muted">
            Vertex MMA is a community platform for UFC fight discussion,
            custom rankings, and virtual coin betting. The Vertex Score is
            a 0–100 measure combining quality wins, championship pedigree,
            recent form, finishing rate, and defensive vulnerability across
            every UFC fighter with three or more bouts.
          </p>
          <p className="mt-4 font-sans text-sm text-foreground-muted">
            A full about page lands in a later wave.
          </p>
        </Container>
      </main>
      <Footer />
    </>
  );
}
