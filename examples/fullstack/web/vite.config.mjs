import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const path = value => fileURLToPath(new URL(value, import.meta.url));
export default defineConfig({
    root: path("./"),
    resolve: { alias: {
        "@boringapi/core/client": path("../../../src/client.ts"),
        "$modules": path("../modules"),
    } },
    server: { port: 5173, proxy: { "/orders": "http://localhost:4041", "/pages": "http://localhost:4041" } },
    build: { outDir: path("../../../.boring/fullstack-build/examples/fullstack/web/dist"), emptyOutDir: true },
});
