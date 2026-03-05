import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: { outDir: "dist", emptyOutDir: true },
  define: {
    "process.env.XMEM_API_URL": JSON.stringify(""),
    "process.env.XMEM_API_KEY": JSON.stringify(""),
  },
});
