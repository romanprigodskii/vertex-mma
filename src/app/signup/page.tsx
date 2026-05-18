import { SignUpForm } from "@/app/signup/sign-up-form";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export const metadata = {
  title: "Sign up",
};

export default function SignUpPage() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="sm" className="py-12 md:py-16">
          <SignUpForm />
        </Container>
      </main>
      <Footer />
    </>
  );
}
