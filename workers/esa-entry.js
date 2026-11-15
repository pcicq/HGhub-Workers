/**
 * 阿里云 ESA「函数和 Pages」薄入口，由 scripts/build-pages.mjs 打包成自包含的 esa-worker.js。
 *
 * 与 Cloudflare 的两点差异只在里收敛：
 *   1. ESA 的签名是 fetch(request, context, env)，env 是第三个参数；
 *   2. ESA 没有 ASSETS 绑定，静态资源由 Pages 静态托管优先返回。
 *
 * 业务 HTML 故意不放进静态目录：否则 ESA 会把 "/" 直接返回给未解锁访客，
 * 解锁页与 CSP 注入全部失效。这里把 dist/index.html 内联（构建时用 esbuild 的
 * text loader 注入），由原 Worker 的 serveAsset 加安全头后返回。
 *
 * 不把 context 传给 worker.fetch：ESA 的 context 没有 waitUntil，
 * 传进去会让 media.ts 的后台缓存写回抛错；不传时代码自动降级为 void task。
 */
import worker, { createEnv } from "./src/index.ts";
import html from "../dist/index.html";

const assetResponse = (request) => {
  const url = new URL(request.url);
  // 能走到函数里的路径，一定是静态目录里不存在的（ESA 静态优先）。
  // HTML 请求由内联产物承载；其余未知路径返回 404，由上层做 SPA 回退。
  if (url.pathname === "/" || url.pathname === "/index.html" || url.pathname.endsWith(".html")) {
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  return new Response("not found", { status: 404 });
};

export default {
  async fetch(request, _context, env) {
    const platformEnv = createEnv({
      get: (name) => env?.[name],
      fetchAsset: async (assetRequest) => assetResponse(assetRequest),
    });
    return worker.fetch(request, platformEnv);
  },
};
