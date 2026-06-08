import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Python virtualenvs vendor minified JS (yt_dlp, shap, sklearn) that
    // ESLint should never lint — they produced 30+ bogus errors.
    "**/venv/**",
    "**/__pycache__/**",
  ]),
  // `eslint-plugin-react-hooks`@6 (bundled with eslint-config-next@16) turns on
  // the React Compiler rule set at "error". Three of those rules fire on
  // patterns this codebase has deliberately adopted — they are not bugs:
  //   • set-state-in-effect — the one-time mount-flag flip
  //     (src/hooks/use-mounted.ts), route-change resets (mobile-nav) and other
  //     client-only hydration sync; not render-driven state cascades.
  //   • purity — Date.now() read during render of async Server Components
  //     (relative timestamps, market closed-state). A server tree renders once,
  //     so there is no client re-render cascade to destabilise.
  //   • refs — the latest-value ref mirror (`queryRef.current = query`) used to
  //     read the freshest query inside a debounce without re-subscribing.
  // Downgrade ONLY these three to "warn": the CI gate (plain `eslint`) stays
  // green, yet they still surface in lint output rather than being silenced.
  // Every other rule keeps its original severity (errors still fail the gate).
  {
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
    },
  },
]);

export default eslintConfig;
