"use client";

// global-error replaces the ENTIRE app shell when the root layout itself
// crashes — the next-intl provider is gone, so we can't use its hooks here.
// Instead we detect the locale from the same signals next-intl uses (the
// NEXT_LOCALE cookie, then the URL prefix, then the browser language) and pick
// copy from a tiny inline EN/RU map so a Russian user doesn't get an
// all-English fatal screen with the wrong lang attribute.
type Locale = "en" | "ru";

const COPY: Record<Locale, { title: string; body: string; retry: string }> = {
  en: {
    title: "Something broke",
    body: "Critical error in the app shell. Try again.",
    retry: "Try again",
  },
  ru: {
    title: "Что-то сломалось",
    body: "Критическая ошибка в оболочке приложения. Попробуйте снова.",
    retry: "Попробовать снова",
  },
};

function detectLocale(): Locale {
  // 1. Explicit user choice — next-intl's locale cookie (default name).
  if (typeof document !== "undefined") {
    const m = document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=(en|ru)\b/);
    if (m) return m[1] as Locale;
  }
  // 2. URL prefix (localePrefix: "as-needed" → only the non-default /ru is set).
  if (typeof window !== "undefined" && /^\/ru(\/|$)/.test(window.location.pathname)) {
    return "ru";
  }
  // 3. Browser language as a last resort.
  if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("ru")) {
    return "ru";
  }
  return "en";
}

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const locale = detectLocale();
  const copy = COPY[locale];

  // global-error runs when the app shell itself crashed — no router/layout
  // available. A full reload is the only reliable way to refetch server
  // data; reset() alone would re-render with the same broken state.
  const handleRetry = () => {
    if (typeof window !== "undefined") window.location.reload();
    else reset();
  };
  return (
    // Locale is resolved on the client. This fallback's subtree is rendered
    // fresh client-side (Next doesn't SSR it to matchable HTML), so there's
    // nothing to hydrate against — suppressHydrationWarning on <html lang> is
    // purely defensive.
    <html lang={locale} suppressHydrationWarning>
      <body
        style={{
          background: "#0a0a0a",
          color: "#fafafa",
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          margin: 0,
        }}
      >
        <div style={{ textAlign: "center", padding: 40 }}>
          <h1 style={{ fontSize: 48, marginBottom: 16 }}>{copy.title}</h1>
          <p style={{ color: "#a3a3a3", marginBottom: 24 }}>{copy.body}</p>
          <button
            onClick={handleRetry}
            style={{
              background: "#f59e0b",
              color: "#0a0a0a",
              padding: "12px 24px",
              border: "none",
              borderRadius: 4,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {copy.retry}
          </button>
        </div>
      </body>
    </html>
  );
}
