import type { MetadataRoute } from "next";

/**
 * PWA web manifest. Gives the app an installable identity, an "add to home
 * screen" name, and a themed splash/status bar matching the dark UI. Icons
 * currently reuse favicon.ico; dedicated 192/512 maskable PNGs are a follow-up.
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
        src: "/favicon.ico",
        sizes: "any",
        type: "image/x-icon",
      },
    ],
  };
}
