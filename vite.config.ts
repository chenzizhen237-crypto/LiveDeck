import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 2896,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 2897 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/livedeck-core/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "safari15",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
