import Link from "next/link";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export default function SimulationNotFound() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="sm" className="py-16 text-center">
          <p className="font-mono text-xs uppercase tracking-widest text-foreground-subtle">
            404
          </p>
          <h1 className="mt-2 font-display text-3xl uppercase tracking-tight text-foreground">
            Simulation not found
          </h1>
          <p className="mt-4 font-sans text-sm text-foreground-muted">
            This simulation may have been deleted, made private, or never
            existed.
          </p>
          <Link
            href="/simulator"
            className="mt-6 inline-flex rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
          >
            Run a simulation
          </Link>
        </Container>
      </main>
      <Footer />
    </>
  );
}
