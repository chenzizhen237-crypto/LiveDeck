import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri loads the dev server on a fixed port (src-tauri/tauri.conf.json devUrl)
// and embeds `dist` in release builds. Tailwind runs through postcss.config.mjs.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) }
  },
  clearScreen: false,
  server: {
    port: 2896,
    strictPort: true,
    // Rust rebuilds touch src-tauri; don't reload the page for them.
    watch: { ignored: ["**/src-tauri/**"] }
  },
  build: {
    outDir: "dist",
    target: "es2022",
    chunkSizeWarningLimit: 2048
  }
});
