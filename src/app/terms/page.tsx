import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export const metadata = { title: "Terms" };

export default function TermsPage() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-16 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
            Vertex MMA
          </p>
          <h1 className="mt-3 font-sans font-bold uppercase tracking-tight text-foreground text-h1">
            Terms
          </h1>
          <p className="mt-6 font-sans text-sm text-foreground-muted">
            A full terms-of-use document lands in a later wave. Quick
            version: virtual coins on Vertex MMA have no monetary value
            and cannot be exchanged for real money. The platform is for
            entertainment.
          </p>
        </Container>
      </main>
      <Footer />
    </>
  );
}
