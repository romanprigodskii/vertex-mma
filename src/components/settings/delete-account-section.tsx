"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import { useRouter } from "@/i18n/navigation";

import { deleteAccountAction } from "@/app/[locale]/settings/actions";

export function DeleteAccountSection() {
  const router = useRouter();
  const t = useTranslations("settings");
  const [showConfirm, setShowConfirm] = React.useState(false);
  const [confirmText, setConfirmText] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onConfirm() {
    if (confirmText !== "DELETE") {
      setError(t("typeDeleteExactly"));
      return;
    }
    setError(null);
    setPending(true);
    const res = await deleteAccountAction();
    if (res?.error) {
      setPending(false);
      setError(res.error);
      return;
    }
    router.push("/");
    router.refresh();
  }

  if (!showConfirm) {
    return (
      <div className="rounded-md border border-streak-loss/30 bg-streak-loss/[0.04] p-4">
        <h3 className="font-display text-sm uppercase tracking-widest text-streak-loss">
          {t("deleteHeading")}
        </h3>
        <p className="mt-2 font-sans text-sm text-foreground-muted">
          {t("deleteSummary")}
        </p>
        <button
          type="button"
          onClick={() => setShowConfirm(true)}
          className="mt-3 rounded-sm border border-streak-loss/40 px-3 py-1.5 font-sans text-sm text-streak-loss hover:bg-streak-loss/10"
        >
          {t("deleteMy")}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-streak-loss/40 bg-streak-loss/[0.04] p-4">
      <h3 className="font-display text-sm uppercase tracking-widest text-streak-loss">
        {t("confirmDeletionHeading")}
      </h3>
      <p className="mt-2 font-sans text-sm text-foreground-muted">
        {t("typeDeletePrefix")}{" "}
        <span className="font-mono font-medium text-foreground">DELETE</span>{" "}
        {t("typeDeleteSuffix")}
      </p>
      <input
        type="text"
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        placeholder="DELETE"
        autoCapitalize="characters"
        className="mt-3 w-full max-w-xs rounded-sm border border-streak-loss/30 bg-background-elevated/30 px-3 py-2 font-mono text-sm text-foreground focus:border-streak-loss focus:outline-none"
      />
      {error ? (
        <p className="mt-2 font-sans text-sm text-streak-loss" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending || confirmText !== "DELETE"}
          className="rounded-sm bg-streak-loss px-3 py-1.5 font-sans text-sm text-background-base hover:opacity-90 disabled:opacity-50"
        >
          {pending ? t("deleting") : t("deleteAccount")}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowConfirm(false);
            setConfirmText("");
            setError(null);
          }}
          disabled={pending}
          className="rounded-sm border border-foreground/15 px-3 py-1.5 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] disabled:opacity-50"
        >
          {t("cancel")}
        </button>
      </div>
    </div>
  );
}
