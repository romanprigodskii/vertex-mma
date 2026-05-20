"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // global-error runs when the app shell itself crashed — no router/layout
  // available. A full reload is the only reliable way to refetch server
  // data; reset() alone would re-render with the same broken state.
  const handleRetry = () => {
    if (typeof window !== "undefined") window.location.reload();
    else reset();
  };
  return (
    <html lang="en">
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
          <h1 style={{ fontSize: 48, marginBottom: 16 }}>Something broke</h1>
          <p style={{ color: "#a3a3a3", marginBottom: 24 }}>
            Critical error in the app shell. Try again.
          </p>
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
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
