import path from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Standalone output bundles only the files the server actually needs
  // (node_modules pruned by Next's tracing). Docker image stays ~150MB
  // instead of dragging the full pnpm store.
  output: "standalone",
  reactCompiler: true,
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
      // Only our own Supabase project, not any *.supabase.co tenant. The broad
      // public-storage path covers both fighter-photos and avatars.
      {
        protocol: "https",
        hostname: "ctixvxfmgrthnspfofsc.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
      {
        protocol: "https",
        hostname: "upload.wikimedia.org",
        pathname: "/**",
      },
    ],
  },
  // Baseline security headers for the public Coolify deploy. A full
  // Content-Security-Policy is deliberately left for a dedicated pass (it
  // needs nonce wiring for Next's inline scripts); these are the safe,
  // high-value headers that don't risk breaking resource loading.
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
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
