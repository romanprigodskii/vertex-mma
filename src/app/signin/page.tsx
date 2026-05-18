import { SignInForm } from "@/app/signin/sign-in-form";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export const metadata = {
  title: "Sign in",
};

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
