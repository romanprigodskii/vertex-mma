import path from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Single source of truth for the Supabase project host, reused by both the
// next/image allowlist and the CSP connect/img directives below.
const SUPABASE_HOST = "ctixvxfmgrthnspfofsc.supabase.co";

// Structural CSP directives that are safe to ENFORCE today: the app never uses
// <base>, <object>/<embed>, or allows itself to be framed, so these block real
// attack vectors (base-tag hijacking, plugin injection, clickjacking) with no
// risk to resource loading. frame-ancestors 'self' is the modern equivalent of
// the X-Frame-Options header kept below — both are sent for legacy coverage.
const cspEnforced = [
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join("; ");

// Full policy shipped in REPORT-ONLY mode first: it blocks nothing, only
// reports violations, so it can be validated against real traffic before being
// enforced. script-src/style-src keep 'unsafe-inline' because Next.js (App
// Router bootstrap, critical CSS, React Compiler) and next-themes emit inline
// script/style with no nonce wired yet.
//
// TODO(csp-enforce): to promote script-src to an enforcing policy, drop
// 'unsafe-inline' and wire a per-request nonce in src/middleware.ts
// (script-src 'self' 'nonce-<n>' 'strict-dynamic'), pass the nonce to Next via
// a request header and to next-themes' <ThemeProvider nonce={...}>, then move
// the CSP into middleware — a static next.config header can't carry a
// per-request nonce. Add a report-to/report-uri endpoint to collect violations.
const cspReportOnly = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https://${SUPABASE_HOST} https://upload.wikimedia.org https://i.ytimg.com`,
  "font-src 'self'",
  `connect-src 'self' https://${SUPABASE_HOST} wss://${SUPABASE_HOST}`,
  "frame-src https://www.youtube-nocookie.com",
  "media-src https://www.youtube-nocookie.com",
].join("; ");

const nextConfig: NextConfig = {
  // Standalone output bundles only the files the server actually needs
  // (node_modules pruned by Next's tracing). Docker image stays ~150MB
  // instead of dragging the full pnpm store.
  output: "standalone",
  reactCompiler: true,
  // Don't advertise the framework in the x-powered-by response header.
  poweredByHeader: false,
  experimental: {
    // Avatar uploads POST the raw file (≤2 MB) to a server action, so the
    // 1 MB server-action body default would reject them. Headroom for the
    // multipart envelope on top of the 2 MB image cap.
    serverActions: {
      bodySizeLimit: "3mb",
    },
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
  images: {
    remotePatterns: [
      {
        // Exact project host (not a *.supabase.co wildcard) — covers every
        // public storage bucket (fighter-photos, avatars, …) we serve.
        protocol: "https",
        hostname: SUPABASE_HOST,
        pathname: "/storage/v1/object/public/**",
      },
      {
        protocol: "https",
        hostname: "upload.wikimedia.org",
        pathname: "/**",
      },
    ],
  },
  // Baseline security headers for the public Coolify deploy. The full
  // Content-Security-Policy ships in Report-Only mode (cspReportOnly) so it can
  // be validated before enforcement; only the structural directives that can't
  // break resource loading are enforced today (cspEnforced). See the notes on
  // those constants above.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          { key: "Content-Security-Policy", value: cspEnforced },
          { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
