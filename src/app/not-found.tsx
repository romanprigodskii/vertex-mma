import Link from "next/link";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export const metadata = { title: "Not found · Vertex MMA" };

export default function NotFoundPage() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-20 text-center md:py-32">
          <p className="font-sans font-bold text-8xl leading-none tabular text-primary">
            404
          </p>
          <h1 className="mt-6 font-sans font-bold text-4xl uppercase tracking-tight text-foreground">
            Page not found
          </h1>
          <p className="mx-auto mt-4 max-w-md font-sans text-base text-foreground-muted">
            The page you&rsquo;re looking for doesn&rsquo;t exist — maybe a
            removed fighter, a deleted ranking, or a typo&rsquo;d URL.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/"
              className="rounded-sm bg-primary px-5 py-2.5 font-sans font-bold text-sm uppercase tracking-widest text-background-base hover:opacity-90"
            >
              Home
            </Link>
            <Link
              href="/fighters"
              className="rounded-sm border border-foreground/15 px-5 py-2.5 font-sans font-bold text-sm uppercase tracking-widest text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
            >
              Browse fighters
            </Link>
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
