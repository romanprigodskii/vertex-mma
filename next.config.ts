import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
    ],
  },
};

export default nextConfig;
