import {resolve} from "node:path";
import {defineConfig} from "vite";

export default defineConfig({
  base: "/ui/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: resolve(process.cwd(), "monitoring-dashboard.html"),
      output: {
        entryFileNames: "assets/monitoring-dashboard-[hash].js",
        assetFileNames: (assetInfo) =>
          assetInfo.names?.some((name) => name.endsWith(".css"))
            ? "assets/monitoring-dashboard-[hash][extname]"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
});
