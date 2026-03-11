import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "https://localhost:3443",
        secure: false,
        changeOrigin: true,
      },
      "/ring": {
        target: "https://localhost:3443",
        secure: false,
        changeOrigin: true,
      },
      "/auth": {
        target: "https://localhost:3443",
        secure: false,
        changeOrigin: true,
      },
      "/notify": {
        target: "https://localhost:3443",
        secure: false,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "../public-react",
  },
});
