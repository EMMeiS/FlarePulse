import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    // Root-relative so this file needs no node typings. Mirrors the "@/*"
    // path in tsconfig.json and the aliases in components.json.
    alias: {
      "@": "/frontend",
    },
  },
  // cloudflare() reads wrangler.jsonc itself and builds the Worker alongside
  // the client, so one `vite build` produces the whole deployable unit.
  plugins: [react(), tailwindcss(), cloudflare()],
});
