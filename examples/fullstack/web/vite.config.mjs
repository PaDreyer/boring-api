import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const path = value => fileURLToPath(new URL(value, import.meta.url));
export default defineConfig({
    root: path("./"),
    resolve: { alias: {
        "$modules": path("../modules"),
    } },
    // Linked workspace packages need explicit CommonJS conversion in dev.
    optimizeDeps: { include: ["@boringapi/core/client"] },
    server: { port: 5173, proxy: { "/orders": "http://localhost:4041", "/pages": "http://localhost:4041" } },
    build: { outDir: path("../dist/web/dist"), emptyOutDir: true },
});
