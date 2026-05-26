import { redirect } from "next/navigation";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { MarkAllReadButton } from "@/components/notifications/mark-all-read-button";
import { NotificationRow } from "@/components/notifications/notification-row";
import { getCurrentUser } from "@/lib/auth";
import { listNotifications } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/notifications");

  const items = await listNotifications(user.userProfileId, 100);
  const hasUnread = items.some((n) => !n.is_read);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-10 md:py-14">
          <header className="mb-8 flex items-baseline justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
                Inbox
              </p>
              <h1 className="mt-2 font-sans font-bold uppercase tracking-tight text-foreground text-h1">
                Notifications
              </h1>
            </div>
            {hasUnread ? <MarkAllReadButton /> : null}
          </header>

          {items.length === 0 ? (
            <p className="py-12 text-center font-sans text-sm text-foreground-muted">
              No notifications yet. Place a bet, make a pick, or unlock an
              achievement — anything that happens will show up here.
            </p>
          ) : (
            <ul className="flex flex-col rounded-md border border-foreground/10 bg-background-elevated/30">
              {items.map((n) => (
                <li key={n.id} className="last:[&>*]:border-b-0">
                  <NotificationRow notification={n} />
                </li>
              ))}
            </ul>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}
