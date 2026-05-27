import { defineRouting } from "next-intl/routing";

/** English stays at the bare URL (as-needed prefix) so every link
 *  shared before this commit keeps resolving. Russian lives behind /ru/. */
export const routing = defineRouting({
  locales: ["en", "ru"],
  defaultLocale: "en",
  localePrefix: "as-needed",
});

export type AppLocale = (typeof routing.locales)[number];
