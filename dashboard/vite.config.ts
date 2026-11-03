import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard calls `/api/*`; in dev, Vite forwards that to the platform API
// so the browser sees one origin. Override the target with API_URL.
const apiTarget = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
