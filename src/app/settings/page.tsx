import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { AvatarUpload } from "@/components/settings/avatar-upload";
import { ChangeEmailForm } from "@/components/settings/change-email-form";
import { ChangePasswordForm } from "@/components/settings/change-password-form";
import { ChangeUsernameForm } from "@/components/settings/change-username-form";
import { DeleteAccountSection } from "@/components/settings/delete-account-section";
import { ProfileEditForm } from "@/components/settings/profile-edit-form";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Settings",
};

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/settings");

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href="/me"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> Back to profile
            </Link>
          </Container>
        </div>

        <Container size="md" className="space-y-12 py-12 md:py-16">
          <header>
            <h1 className="font-display text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
              Settings
            </h1>
            <p className="mt-2 font-sans text-sm text-foreground-muted">
              Update your profile, change your username, email or password,
              or delete your account.
            </p>
          </header>

          <section>
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              Avatar
            </h2>
            <AvatarUpload
              currentUrl={user.avatarUrl}
              authUserId={user.authUserId}
              username={user.username}
            />
          </section>

          <section>
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              Profile
            </h2>
            <ProfileEditForm
              initialDisplayName={user.displayName ?? ""}
              initialBio={user.bio ?? ""}
              initialCountryCode={user.countryCode ?? ""}
            />
          </section>

          <section>
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              Username
            </h2>
            <ChangeUsernameForm
              currentUsername={user.username}
              usernameLastChangedAt={user.usernameLastChangedAt}
            />
          </section>

          <section>
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              Email
            </h2>
            <ChangeEmailForm currentEmail={user.email ?? ""} />
          </section>

          <section>
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              Password
            </h2>
            <ChangePasswordForm />
          </section>

          <section>
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-streak-loss">
              Danger zone
            </h2>
            <DeleteAccountSection />
          </section>
        </Container>
      </main>
      <Footer />
    </>
  );
}
