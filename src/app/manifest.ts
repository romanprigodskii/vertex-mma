import type { MetadataRoute } from "next";

/**
 * PWA web manifest. Gives the app an installable identity, an "add to home
 * screen" name, and a themed splash/status bar matching the dark UI. Icons are
 * the generated brand-gold "V" (src/app/icon.tsx + apple-icon.tsx); dedicated
 * 192/512 maskable PNGs are a follow-up.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Vertex MMA",
    short_name: "Vertex",
    description:
      "AI-powered MMA fight simulator, UFC rankings, predictions and a virtual sportsbook.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0b0e",
    theme_color: "#0a0b0e",
    icons: [
      {
        src: "/icon",
        sizes: "32x32",
        type: "image/png",
      },
      {
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  };
}
