import type { MetadataRoute } from "next";

/**
 * PWA web manifest. Gives the app an installable identity, an "add to home
 * screen" name, and a themed splash/status bar matching the dark UI. Icon is
 * the static brand-gold "V" (src/app/icon.svg) — a static file so it serves
 * correctly under `output: standalone` (generated ImageResponse icons 404
 * there); dedicated 192/512 maskable PNGs are a follow-up.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Vertex MMA",
    short_name: "Vertex",
    description:
      "AI-powered MMA fight simulator, UFC rankings and a virtual sportsbook.",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0b0e",
    theme_color: "#0a0b0e",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
    ],
  };
}
