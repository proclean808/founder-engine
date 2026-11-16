import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root,
  base: "/app/",
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("../public/app", import.meta.url)), emptyOutDir: true, sourcemap: false },
  server: { proxy: { "/api": "http://localhost:3000" } },
});
