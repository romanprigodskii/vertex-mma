"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import { uploadAvatarAction } from "@/app/[locale]/settings/actions";

interface Props {
  currentUrl: string | null;
  username: string;
}

const ALLOWED = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 2 * 1024 * 1024;

export function AvatarUpload({ currentUrl, username }: Props) {
  const t = useTranslations("settings");
  const [preview, setPreview] = React.useState<string | null>(currentUrl);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so the same filename can be re-selected after an error.
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;

    // Client-side pre-checks for instant feedback; the server re-validates
    // and is the actual gate (it owns the storage path and the upload).
    if (file.size > MAX_BYTES) {
      setError(t("avatarTooLarge"));
      return;
    }
    if (!ALLOWED.includes(file.type)) {
      setError(t("avatarWrongType"));
      return;
    }

    setError(null);
    setPending(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await uploadAvatarAction(formData);
      if (res?.error) throw new Error(res.error);
      if (res?.url) setPreview(res.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("uploadFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt={t("avatarPreviewAlt", { username })}
          className="h-20 w-20 rounded-full border border-foreground/15 object-cover"
        />
      ) : (
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/15 font-display text-xl uppercase text-primary">
          {username.slice(0, 2)}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <label className="inline-flex w-fit cursor-pointer items-center rounded-sm border border-foreground/15 px-3 py-1.5 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground">
          {pending ? t("uploading") : t("chooseImage")}
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            disabled={pending}
            onChange={onFile}
          />
        </label>
        <span className="font-sans text-[11px] text-foreground-subtle">
          {t("avatarFormatHint")}
        </span>
        {error ? (
          <span className="font-sans text-xs text-streak-loss">{error}</span>
        ) : null}
      </div>
    </div>
  );
}
