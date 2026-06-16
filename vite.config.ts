import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        captured: resolve(__dirname, "captured.html"),
        sw: resolve(__dirname, "src/sw.ts"),
        // captured.html uses an inlined script (no module entry needed)
      },
      output: {
        // emit the service worker as /sw.js (no hash) so registration path is stable
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
});
