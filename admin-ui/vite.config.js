import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  base: "/admin/",
  server: {
    port: 5180,
    proxy: {
      "/api": "http://localhost:3600",
    },
  },
  build: {
    outDir: "dist",
  },
});
