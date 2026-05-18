import { ResetPasswordForm } from "@/app/auth/reset-password/reset-password-form";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export const metadata = {
  title: "Reset password",
};

export default function ResetPasswordPage() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="sm" className="py-12 md:py-16">
          <ResetPasswordForm />
        </Container>
      </main>
      <Footer />
    </>
  );
}
