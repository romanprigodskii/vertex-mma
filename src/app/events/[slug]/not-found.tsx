import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Button } from "@/components/ui/button";

export default function EventNotFound() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container
          size="xl"
          className="flex flex-col items-center justify-center gap-6 py-24 text-center md:py-32"
        >
          <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-foreground-subtle">
            404 · No such event
          </p>
          <h1
            className="font-display uppercase tracking-tight text-foreground leading-[0.9]"
            style={{ fontSize: "clamp(40px, 6vw, 80px)" }}
          >
            Event not found
          </h1>
          <p className="max-w-md font-sans text-sm text-foreground-muted">
            We could not find an event with that slug. The URL may be
            mistyped, or the event has not been indexed yet.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href="/fighters">
              <ChevronLeft className="h-4 w-4" />
              Back to roster
            </Link>
          </Button>
        </Container>
      </main>
      <Footer />
    </>
  );
}
