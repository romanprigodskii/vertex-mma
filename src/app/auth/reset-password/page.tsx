import { ResetPasswordForm } from "@/app/auth/reset-password/reset-password-form";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { createClient } from "@/lib/supabase/server";

export const metadata = {
  title: "Reset password",
};

// /auth/callback exchanges the recovery code for a session before redirecting
// here, so a valid link always arrives with one. When there's no session
// (direct navigation, or an expired/used link that never minted one), render
// the invalid-link state instead of a password form that will only fail on
// submit. Reading the session opts the route into dynamic rendering.
export const dynamic = "force-dynamic";

export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="sm" className="py-12 md:py-16">
          <ResetPasswordForm invalid={!user} />
        </Container>
      </main>
      <Footer />
    </>
  );
}
