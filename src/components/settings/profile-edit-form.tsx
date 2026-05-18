"use client";

import * as React from "react";

import { updateProfileAction } from "@/app/settings/actions";

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
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

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
      <Field
        label="Display name"
        hint="Shown above your username on /me. Up to 60 characters."
      >
        <input
          name="displayName"
          defaultValue={initialDisplayName}
          maxLength={60}
          className={INPUT_CLASS}
        />
      </Field>
      <Field label="Bio" hint="Short bio, up to 280 characters.">
        <textarea
          name="bio"
          defaultValue={initialBio}
          maxLength={280}
          rows={3}
          className={`${INPUT_CLASS} resize-y`}
        />
      </Field>
      <Field
        label="Country code"
        hint="Two-letter ISO code (e.g. BR, US, RU). Leave blank to clear."
      >
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
        <p className="font-sans text-sm text-streak-win">Saved.</p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Saving…" : "Save"}
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
