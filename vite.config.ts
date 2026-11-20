import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 上游源码保留 Tauri 调用；H5 渠道在构建期把原生 API 换成浏览器实现。
  resolve: {
    alias: {
      "@edition-bootstrap": fileURLToPath(new URL("./src/main.tsx", import.meta.url)),
      "@tauri-apps/api/core": fileURLToPath(new URL("./src/h5/tauri-core-shim.ts", import.meta.url)),
      "@tauri-apps/api/window": fileURLToPath(new URL("./src/h5/tauri-window-shim.ts", import.meta.url)),
      "@tauri-apps/plugin-clipboard-manager": fileURLToPath(new URL("./src/h5/clipboard-shim.ts", import.meta.url)),
    },
  },
  clearScreen: false,
  // 版本号只维护 package.json（CI 会按 tag 改写它），界面里的版本由这里注入，避免写死后漂移
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**", "**/workers/**"] },
    // H5 浏览器联调：把同源 /hg/* 转给本地 wrangler dev（默认 8787）。
    // 需要在 workers/.dev.vars 里配 H5_ALLOWED_ORIGIN=http://localhost:1420。
    proxy: {
      "/hg": {
        target: process.env.H5_DEV_PROXY || "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
