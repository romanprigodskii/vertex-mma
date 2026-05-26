import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export const metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-16 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
            Vertex MMA
          </p>
          <h1 className="mt-3 font-sans font-bold uppercase tracking-tight text-foreground text-h1">
            Privacy
          </h1>
          <p className="mt-6 font-sans text-sm text-foreground-muted">
            A full privacy policy lands in a later wave. In the meantime:
            we store the data you provide (email, username, profile fields,
            bets, rankings), use it to run your account, and don&apos;t
            share it with third parties. Auth + storage are handled by
            Supabase.
          </p>
        </Container>
      </main>
      <Footer />
    </>
  );
}
