"use client";

import * as React from "react";

import { updateAvatarUrlAction } from "@/app/[locale]/settings/actions";
import { createClient } from "@/lib/supabase/client";

interface Props {
  currentUrl: string | null;
  authUserId: string;
  username: string;
}

const ALLOWED = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 2 * 1024 * 1024;

export function AvatarUpload({ currentUrl, authUserId, username }: Props) {
  const supabase = React.useMemo(() => createClient(), []);
  const [preview, setPreview] = React.useState<string | null>(currentUrl);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so the same filename can be re-selected after an error.
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;

    if (file.size > MAX_BYTES) {
      setError("Avatar must be under 2 MB.");
      return;
    }
    if (!ALLOWED.includes(file.type)) {
      setError("Avatar must be PNG, JPEG, or WebP.");
      return;
    }

    setError(null);
    setPending(true);
    try {
      const ext =
        file.type === "image/jpeg"
          ? "jpg"
          : file.type === "image/webp"
            ? "webp"
            : "png";
      const path = `${authUserId}/avatar.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from("avatars")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (uploadError) throw uploadError;

      const {
        data: { publicUrl },
      } = supabase.storage.from("avatars").getPublicUrl(path);

      // Cache-bust so the CDN-cached <img src> refreshes immediately.
      const versionedUrl = `${publicUrl}?v=${Date.now()}`;
      const res = await updateAvatarUrlAction(versionedUrl);
      if (res?.error) throw new Error(res.error);

      setPreview(versionedUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
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
          alt={`${username} avatar preview`}
          className="h-20 w-20 rounded-full border border-foreground/15 object-cover"
        />
      ) : (
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-primary/15 font-display text-xl uppercase text-primary">
          {username.slice(0, 2)}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <label className="inline-flex w-fit cursor-pointer items-center rounded-sm border border-foreground/15 px-3 py-1.5 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground">
          {pending ? "Uploading…" : "Choose image"}
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
          PNG / JPEG / WebP, up to 2 MB.
        </span>
        {error ? (
          <span className="font-sans text-xs text-streak-loss">{error}</span>
        ) : null}
      </div>
    </div>
  );
}
