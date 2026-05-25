"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";

import type { NotificationRow } from "@/lib/notifications";

interface Props {
  initialUnreadCount: number;
  initialRecent: NotificationRow[];
}

export function NavbarNotifications({
  initialUnreadCount,
  initialRecent,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Poor-man's real-time: re-fetch server state when the tab regains focus
  // (claim a daily bonus elsewhere → return to this tab → count refreshes).
  // True realtime would need a Supabase channel subscription — separate wave.
  React.useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [router]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={
          initialUnreadCount > 0
            ? `Notifications · ${initialUnreadCount} unread`
            : "Notifications"
        }
        aria-haspopup="menu"
        aria-expanded={open}
        className="relative rounded-sm p-1.5 text-fg-muted transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.05] hover:text-fg"
      >
        <Bell className="h-5 w-5" />
        {initialUnreadCount > 0 ? (
          <span
            className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-fg"
            aria-hidden
          />
        ) : null}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 w-80 max-w-[90vw] rounded-md border border-edge bg-surface-elevated shadow-lg"
        >
          <div className="flex items-baseline justify-between border-b border-edge px-3 py-2">
            <p className="type-meta text-xs text-fg-muted">Notifications</p>
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="type-body text-xs text-fg hover:underline"
            >
              See all
            </Link>
          </div>
          {initialRecent.length === 0 ? (
            <p className="type-body px-3 py-6 text-center text-xs text-fg-muted">
              All caught up.
            </p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {initialRecent.map((n) => (
                <li key={n.id}>
                  {n.link ? (
                    <Link
                      href={n.link}
                      onClick={() => setOpen(false)}
                      prefetch={false}
                      className="block border-b border-fg/[0.06] px-3 py-2 transition-colors duration-(--motion-fast) ease-out-soft hover:bg-fg/[0.03]"
                    >
                      <p className="type-body line-clamp-1 text-sm text-fg">
                        {n.title}
                      </p>
                      {n.body ? (
                        <p className="type-body mt-0.5 line-clamp-1 text-xs text-fg-muted">
                          {n.body}
                        </p>
                      ) : null}
                    </Link>
                  ) : (
                    <div className="border-b border-fg/[0.06] px-3 py-2">
                      <p className="type-body line-clamp-1 text-sm text-fg">
                        {n.title}
                      </p>
                      {n.body ? (
                        <p className="type-body mt-0.5 line-clamp-1 text-xs text-fg-muted">
                          {n.body}
                        </p>
                      ) : null}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
