import { NavbarInner } from "@/components/layout/navbar-inner";
import { getCurrentUser } from "@/lib/auth";

export async function Navbar() {
  const user = await getCurrentUser();
  return <NavbarInner user={user} />;
}
