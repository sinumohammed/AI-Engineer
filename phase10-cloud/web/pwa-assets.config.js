import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

// Phase 10 UI: the home-screen icons, generated from public/logo.svg.
// Regenerate after changing the logo: npx pwa-assets-generator
export default defineConfig({
  headLinkOptions: { preset: "2023" },
  preset: {
    ...minimal2023Preset,
    // The maskable icon (Android) needs the logo's own background colour,
    // so phones that crop icons to a circle show no white edge.
    maskable: { ...minimal2023Preset.maskable, padding: 0, resizeOptions: { background: "#6d5ff5" } },
    apple: { ...minimal2023Preset.apple, padding: 0, resizeOptions: { background: "#6d5ff5" } },
  },
  images: ["public/logo.svg"],
});
