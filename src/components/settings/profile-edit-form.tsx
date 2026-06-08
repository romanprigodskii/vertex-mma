"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import { updateProfileAction } from "@/app/[locale]/settings/actions";

const INPUT_CLASS =
  "rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none";

interface Props {
  initialDisplayName: string;
  initialBio: string;
  initialCountryCode: string;
}

export function ProfileEditForm({
  initialDisplayName,
  initialBio,
  initialCountryCode,
}: Props) {
  const t = useTranslations("settings");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  // Auto-dismiss the "Saved." confirmation so it doesn't linger as stale
  // state. A fresh submit calls setSaved(false) first, which tears down any
  // in-flight timer via the cleanup before the next success re-arms it.
  React.useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [saved]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setPending(true);
    const res = await updateProfileAction(new FormData(e.currentTarget));
    setPending(false);
    if (res?.error) setError(res.error);
    else setSaved(true);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <Field label={t("displayName")} hint={t("displayNameHint")}>
        <input
          name="displayName"
          defaultValue={initialDisplayName}
          maxLength={60}
          className={INPUT_CLASS}
        />
      </Field>
      <Field label={t("bio")} hint={t("bioHint")}>
        <textarea
          name="bio"
          defaultValue={initialBio}
          maxLength={280}
          rows={3}
          className={`${INPUT_CLASS} resize-y`}
        />
      </Field>
      <Field label={t("countryCode")} hint={t("countryCodeHint")}>
        <input
          name="countryCode"
          defaultValue={initialCountryCode}
          maxLength={2}
          className={`${INPUT_CLASS} uppercase`}
        />
      </Field>
      {error ? (
        <p className="font-sans text-sm text-streak-loss" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="font-sans text-sm text-streak-win" role="status">
          {t("saved")}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
      >
        {pending ? t("saving") : t("save")}
      </button>
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="font-sans text-[11px] text-foreground-subtle">
          {hint}
        </span>
      ) : null}
    </label>
  );
}
