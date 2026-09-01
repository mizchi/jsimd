import { Buffer } from "node:buffer";
import { defineConfig } from "vite";

export default defineConfig({
  build: { assetsInlineLimit: 0 },
  server: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  plugins: [{
    name: "benchmark-report",
    configureServer(server) {
      server.middlewares.use("/__benchmark_report", (request, response) => {
        const chunks: Uint8Array[] = [];
        request.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        request.on("end", () => {
          const report = Buffer.concat(chunks).toString("utf8");
          console.log(`UI_BENCHMARK_RESULT ${report}`);
          response.statusCode = 204;
          response.end();
        });
      });
    },
  }],
});
