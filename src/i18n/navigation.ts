import { createNavigation } from "next-intl/navigation";

import { routing } from "./routing";

/** Locale-aware wrappers around next/link, useRouter, etc. Used by the
 *  language toggle and any component that needs to navigate while
 *  preserving (or explicitly switching) the active locale. */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
