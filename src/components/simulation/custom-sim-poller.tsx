"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const POLL_MS = 4_000;
const MAX_POLLS = 45; // ~3 min — after that the page shows the stalled hint

/** While a custom simulation is pending, re-fetch the server component tree
 *  every few seconds until the worker fills the result. Renders nothing. */
export function CustomSimPoller({ status }: { status: string }) {
  const router = useRouter();
  const polls = useRef(0);

  useEffect(() => {
    if (status !== "pending") return;
    const id = setInterval(() => {
      polls.current += 1;
      if (polls.current > MAX_POLLS) {
        clearInterval(id);
        return;
      }
      router.refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [status, router]);

  return null;
}
