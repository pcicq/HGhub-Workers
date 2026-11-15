// HGhub-Workers H5 渠道入口：同一 Worker 同时托管 dist 静态资源与同源代理。
// 访问控制：口令（HttpOnly Cookie）+ 同源校验；代理端点不对外暴露上游接口与直链。
import {
  API_CONTRACT, APP_VERSION, CHANNEL, MEDIA_PREFIX, SESSION_MAX_AGE,
} from "./config";
import {
  accessCookie, accessSignature, b64, hasAccess, json, keyMatches, originOk, text,
  type Env,
} from "./policy";
import { createRpcContext, dispatchRpc, type Args } from "./rpc";
import { handleMedia, type MediaRoute } from "./media";

// 对外暴露平台适配契约：其它 WinterTC 运行时用 createEnv() 构造 env 后复用 default.fetch
export { createEnv, type PlatformAdapter } from "./platform";

const HTML_UNLOCK = (error: boolean): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#101012"><title>HGhub-Workers · H5 访问</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;
background:#101012;color:#f2f2f3;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;padding:24px}
main{width:min(100%,380px);background:#1a1a1e;border:1px solid #2c2c33;border-radius:18px;padding:28px}
h1{font-size:18px;margin:0 0 6px}p{margin:0 0 20px;color:#9a9aa4;font-size:13px}
label{display:block;font-size:12px;color:#9a9aa4;margin-bottom:8px}
input{width:100%;height:42px;padding:0 12px;border-radius:10px;border:1px solid #35353e;background:#101012;color:#f2f2f3;font-size:14px}
input:focus{outline:2px solid #4cc2ff;outline-offset:1px}
button{width:100%;height:42px;margin-top:14px;border:0;border-radius:10px;background:#4cc2ff;color:#072331;font-weight:700;font-size:14px;cursor:pointer}
.err{color:#ff8a8a;margin:10px 0 0;font-size:12px}
small{display:block;margin-top:18px;color:#6f6f79;font-size:11px;line-height:1.5}
</style></head><body><main>
<h1>HGhub-Workers · H5</h1>
<p>此站点仅供个人学习使用，需要访问口令。</p>
<form method="post" action="${MEDIA_PREFIX}/unlock">
<label for="key">访问口令</label>
<input id="key" name="key" type="password" autocomplete="current-password" autofocus required>
<button type="submit">进入</button></form>
${error ? '<p class="err">口令不正确，请重试。</p>' : ""}
<small>仅限非商业用途。请勿公开传播接口地址或播放直链；相关内容来自第三方站点，请在 24 小时内删除并支持正版。</small>
</main></body></html>`;

/** 为 HTML 里的内联脚本计算 CSP hash，避免为了启动脚本放开 script-src 'unsafe-inline' */
async function inlineScriptHashes(html: string): Promise<string[]> {
  const out: string[] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(match[1]) || !match[2].trim()) continue;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[2]));
    out.push(`'sha256-${b64(new Uint8Array(digest))}'`);
  }
  return out;
}

async function securityHeaders(source: Headers, html: string | null, cacheControl: string): Promise<Headers> {
  const headers = new Headers(source);
  const hashes = html ? await inlineScriptHashes(html) : [];
  const csp = [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  headers.set("Content-Security-Policy", csp);
  headers.set("X-Content-Type-Options", "nosniff");
  // 同源请求保留 Referer 供 CSRF 复核，跨站外链不泄露本页地址
  headers.set("Referrer-Policy", "same-origin");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  headers.set("Cache-Control", cacheControl);
  return headers;
}

function isDocument(request: Request, response: Response): boolean {
  const type = response.headers.get("content-type") ?? "";
  return type.includes("text/html")
    || (request.headers.get("sec-fetch-dest") === "document"
      && (request.headers.get("accept") ?? "").includes("text/html"));
}

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let response = await env.ASSETS.fetch(request);
  if (response.status === 404 && (url.pathname.endsWith(".html") || isDocument(request, response))) {
    response = await env.ASSETS.fetch(
      new Request(new URL("/index.html", url).toString(), { method: "GET", headers: request.headers }),
    );
  }
  const cache = url.pathname.startsWith("/assets/")
    ? "public, max-age=31536000, immutable"
    : "public, max-age=3600";
  if (isDocument(request, response)) {
    const html = await response.text();
    const headers = await securityHeaders(response.headers, html, "no-store");
    return new Response(html, { status: response.status, headers });
  }
  const headers = await securityHeaders(response.headers, null, cache);
  return new Response(response.body, { status: response.status, headers });
}

async function unlock(request: Request, env: Env, signature: string): Promise<Response> {
  if (!originOk(request, env, false)) return text("来源不允许", 403);
  let key = "";
  try {
    const form = await request.formData();
    key = String(form.get("key") ?? "");
  } catch { /* 解析失败按错误口令处理 */ }
  if (key && await keyMatches(env.H5_ACCESS_KEY, key)) {
    return new Response(null, {
      status: 303,
      headers: { "Location": "/", "Set-Cookie": accessCookie(signature, SESSION_MAX_AGE) },
    });
  }
  return new Response(null, { status: 303, headers: { "Location": "/?err=1" } });
}

async function rpc(request: Request, env: Env): Promise<Response> {
  if (!originOk(request, env, true)) return json({ error: "请求来源不允许" }, 403);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 64 * 1024) return json({ error: "请求体过大" }, 413);
  let payload: unknown;
  try { payload = await request.json(); }
  catch { return json({ error: "请求体不是 JSON" }, 400); }
  const body = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const cmd = typeof body.cmd === "string" ? body.cmd : "";
  const args: Args = body.args && typeof body.args === "object" && !Array.isArray(body.args)
    ? body.args as Args : {};
  if (!cmd) return json({ error: "缺少 cmd" }, 400);

  const ctx = await createRpcContext(request, env);
  try {
    const data = await dispatchRpc(cmd, args, ctx);
    const headers = new Headers();
    for (const cookie of ctx.cookies) headers.append("Set-Cookie", cookie);
    return json({ channel: CHANNEL, api: API_CONTRACT, data: data ?? null }, 200, headers);
  } catch (error) {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "请求失败";
    const headers = new Headers();
    for (const cookie of ctx.cookies) headers.append("Set-Cookie", cookie);
    return json({ error: message }, 400, headers);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // 能力探针：前端启动前先确认这是预期版本的 H5 网关，形状不对就刹停
    if (path === `${MEDIA_PREFIX}/health`) {
      // 配置缺失也要让探针失败，否则前端会以为网关可用却不断收到 503
      if (!env.H5_ACCESS_KEY) return json({ error: "H5_ACCESS_KEY 未配置" }, 503);
      return json({ channel: CHANNEL, api: API_CONTRACT, version: APP_VERSION, auth: "cookie" });
    }

    if (!env.H5_ACCESS_KEY) {
      return text("H5_ACCESS_KEY 未配置：请先执行 wrangler secret put H5_ACCESS_KEY", 503);
    }
    const signature = await accessSignature(env.H5_ACCESS_KEY);
    const unlocked = hasAccess(request, signature);

    if (path === `${MEDIA_PREFIX}/unlock` && request.method === "POST") {
      return unlock(request, env, signature);
    }

    if (path.startsWith(`${MEDIA_PREFIX}/`)) {
      if (!unlocked) return json({ error: "需要访问口令，请刷新页面" }, 401);
      if (!originOk(request, env, request.method === "POST")) {
        return json({ error: "请求来源不允许" }, 403);
      }
      if (path === `${MEDIA_PREFIX}/rpc` && request.method === "POST") return rpc(request, env);
      const route = path.slice(MEDIA_PREFIX.length + 1) as MediaRoute;
      if ((route === "img" || route === "hls" || route === "seg") && request.method === "GET") {
        const base = (await createRpcContext(request, env)).base;
        return handleMedia(request, env, base, route);
      }
      return text("not found", 404);
    }

    // HTML 入口未解锁时给静态解锁页；静态资源（JS/CSS）本身不含上游接口或直链
    if (!unlocked && (path === "/" || path === "/index.html" || path.endsWith(".html"))) {
      const html = HTML_UNLOCK(url.searchParams.get("err") === "1");
      const headers = await securityHeaders(new Headers({ "Content-Type": "text/html; charset=utf-8" }), html, "no-store");
      return new Response(html, { status: 200, headers });
    }
    return serveAsset(request, env);
  },
};
