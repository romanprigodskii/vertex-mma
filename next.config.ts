import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Standalone output bundles only the files the server actually needs
  // (node_modules pruned by Next's tracing). Docker image stays ~150MB
  // instead of dragging the full pnpm store.
  output: "standalone",
  reactCompiler: true,
  turbopack: {
    root: path.resolve(__dirname),
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "ctixvxfmgrthnspfofsc.supabase.co",
        pathname: "/storage/v1/object/public/fighter-photos/**",
      },
      {
        protocol: "https",
        hostname: "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
      {
        protocol: "https",
        hostname: "upload.wikimedia.org",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
