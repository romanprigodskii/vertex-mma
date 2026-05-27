import { SignInForm } from "@/app/[locale]/signin/sign-in-form";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export const metadata = {
  title: "Sign in",
};

// SignInForm uses useSearchParams(); marking the route dynamic avoids the
// "must be wrapped in Suspense" build failure on the prerendered shell.
export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="sm" className="py-12 md:py-16">
          <SignInForm />
        </Container>
      </main>
      <Footer />
    </>
  );
}
