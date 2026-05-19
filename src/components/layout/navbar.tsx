import { NavbarInner } from "@/components/layout/navbar-inner";
import { getCurrentUser } from "@/lib/auth";
import { getUnreadCount, listRecentUnread } from "@/lib/notifications";

export async function Navbar() {
  const user = await getCurrentUser();
  const [unreadCount, recentNotifications] = user
    ? await Promise.all([
        getUnreadCount(user.userProfileId),
        listRecentUnread(user.userProfileId, 5),
      ])
    : [0, []];
  return (
    <NavbarInner
      user={user}
      unreadCount={unreadCount}
      recentNotifications={recentNotifications}
    />
  );
}
