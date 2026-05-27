"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { markAllReadAction } from "@/app/[locale]/notifications/actions";

export function MarkAllReadButton() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  async function onClick() {
    setPending(true);
    await markAllReadAction();
    setPending(false);
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="rounded-sm border border-foreground/15 px-3 py-1.5 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground disabled:opacity-50"
    >
      {pending ? "Marking…" : "Mark all read"}
    </button>
  );
}
