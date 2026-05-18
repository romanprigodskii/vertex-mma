import { ForgotPasswordForm } from "@/app/auth/forgot-password/forgot-password-form";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export const metadata = {
  title: "Forgot password",
};

export default function ForgotPasswordPage() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="sm" className="py-12 md:py-16">
          <ForgotPasswordForm />
        </Container>
      </main>
      <Footer />
    </>
  );
}
