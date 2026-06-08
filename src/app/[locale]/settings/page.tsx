import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
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
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "settings" });
  return { title: t("metaTitle") };
}

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("settings");
  const localePrefix = locale === "en" ? "" : `/${locale}`;
  const user = await getCurrentUser();
  if (!user) redirect(`${localePrefix}/signin?next=${localePrefix}/settings`);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="md" className="py-3">
            <Link
              href="/me"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> {t("backToProfile")}
            </Link>
          </Container>
        </div>

        <Container size="md" className="space-y-12 py-12 md:py-16">
          <header>
            <h1 className="font-display text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
              {t("heading")}
            </h1>
            <p className="mt-2 font-sans text-sm text-foreground-muted">
              {t("lead")}
            </p>
          </header>

          <section>
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              {t("sectionAvatar")}
            </h2>
            <AvatarUpload
              currentUrl={user.avatarUrl}
              username={user.username}
            />
          </section>

          <section>
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              {t("sectionProfile")}
            </h2>
            <ProfileEditForm
              initialDisplayName={user.displayName ?? ""}
              initialBio={user.bio ?? ""}
              initialCountryCode={user.countryCode ?? ""}
            />
          </section>

          <section>
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              {t("sectionUsername")}
            </h2>
            <ChangeUsernameForm
              currentUsername={user.username}
              usernameLastChangedAt={user.usernameLastChangedAt}
            />
          </section>

          <section>
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              {t("sectionEmail")}
            </h2>
            <ChangeEmailForm
              currentEmail={user.email ?? ""}
              hasPassword={user.hasPassword}
            />
          </section>

          <section>
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              {t("sectionPassword")}
            </h2>
            <ChangePasswordForm />
          </section>

          <section>
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-streak-loss">
              {t("dangerZone")}
            </h2>
            <DeleteAccountSection hasPassword={user.hasPassword} />
          </section>
        </Container>
      </main>
      <Footer />
    </>
  );
}
