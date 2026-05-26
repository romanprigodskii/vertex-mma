import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { FightCardForm } from "@/components/cards/fight-card-form";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata = { title: "Build a fight card" };

export default async function CreateCardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/cards/create");

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href="/cards"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> All cards
            </Link>
          </Container>
        </div>

        <Container size="lg" className="py-10 md:py-14">
          <header className="mb-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              New card
            </p>
            <h1 className="mt-2 font-sans font-bold text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
              Build a fight card
            </h1>
          </header>
          <FightCardForm mode="create" />
        </Container>
      </main>
      <Footer />
    </>
  );
}
