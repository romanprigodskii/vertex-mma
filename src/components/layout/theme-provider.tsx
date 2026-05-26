"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/** Single source of truth for the project's theme switching.
 *  - data-theme attribute (not class) so it matches our globals.css
 *    `:root[data-theme="light"]` overrides.
 *  - default "dark" because the design was built dark-first.
 *  - disableTransitionOnChange so the swap isn't a smear of color
 *    transitions across the whole tree. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="dark"
      enableSystem
      themes={["light", "dark"]}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
