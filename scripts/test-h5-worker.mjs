/**
 * H5 Worker 请求路径冒烟测试：
 *   把 workers/src/index.ts 打包后直接在 Node 里调用 default.fetch，
 *   用 mock 的 ASSETS / 口令校验解锁、同源、CSP、SSRF 等关键分支。
 * 全程不发起真实网络请求，也不依赖 wrangler / Cloudflare 账号。
 * 任何一项不符直接 exit 1，避免「类型检查通过但访问控制静默失效」。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// pnpm 各版本的 hoisted 布局不同：10/12 会在 node_modules/.bin 建软链，
// pnpm 9 只把 esbuild 放在 .pnpm/node_modules 下且不建 .bin 链接。
// 三处都指向同一个原生二进制，任一存在即可直接执行。
const esbuild = [
  join(root, "node_modules/.bin/esbuild"),
  join(root, "node_modules/esbuild/bin/esbuild"),
  join(root, "node_modules/.pnpm/node_modules/esbuild/bin/esbuild"),
].find((path) => existsSync(path));
if (!esbuild) {
  console.error("找不到 esbuild，请先执行 corepack pnpm install --frozen-lockfile");
  process.exit(1);
}

// 不写临时文件：单入口不指定 outfile 时 esbuild 把结果输出到 stdout，再用 data: URL 加载。
const code = execFileSync(esbuild, [
  "workers/src/index.ts", "--bundle", "--format=esm", "--platform=browser",
  "--target=es2022", "--log-level=error",
], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const bundle = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const worker = bundle.default;

const KEY = "smoke-test-key";
const ORIGIN = "https://h5.example.test";
const html = `<!doctype html><html><head><script>try{localStorage.getItem('t')}catch(e){}</script></head><body>ok</body></html>`;

const env = {
  H5_ACCESS_KEY: KEY,
  ASSETS: {
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/assets/app.js") {
        return new Response("console.log(1)", { status: 200, headers: { "content-type": "text/javascript" } });
      }
      return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  },
};

const req = (path, init = {}) => new Request(ORIGIN + path, init);
const post = (path, body, extra = {}) => req(path, {
  method: "POST",
  headers: { "content-type": "application/json", origin: ORIGIN, ...extra },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

let failed = 0;
let total = 0;
const check = (name, ok) => {
  total++;
  if (!ok) { failed++; console.error(`  FAIL  ${name}`); }
};

/* ── 能力探针与配置缺失 ─────────────────────────────────── */
{
  const r = await worker.fetch(req("/hg/health"), env);
  const j = await r.json();
  check("health 探针形状", r.status === 200 && j.channel === "h5" && j.api === 1 && j.version === "2.1.0");
}
{
  const r = await worker.fetch(req("/hg/health"), { ...env, H5_ACCESS_KEY: "" });
  check("缺少 H5_ACCESS_KEY → 503", r.status === 503);
}

/* ── 平台适配契约：核心 handler 不绑定 Cloudflare 专有 API ── */
{
  const adapted = bundle.createEnv({
    get: (name) => ({ H5_ACCESS_KEY: KEY })[name],
    fetchAsset: (request) => env.ASSETS.fetch(request),
  });
  const health = await worker.fetch(req("/hg/health"), adapted);
  const body = await health.json();
  check("适配层构造的 env 可跑通探针", health.status === 200 && body.channel === "h5" && body.api === 1);
  const page = await worker.fetch(req("/"), adapted);
  check("适配层构造的 env 返回解锁页", page.status === 200 && (await page.text()).includes("访问口令"));
}
{
  const noKey = bundle.createEnv({
    get: () => undefined,
    fetchAsset: (request) => env.ASSETS.fetch(request),
  });
  const r = await worker.fetch(req("/hg/health"), noKey);
  check("适配层缺口令时探针 503", r.status === 503);
}

/* ── 未解锁入口 ─────────────────────────────────────────── */
{
  const r = await worker.fetch(req("/"), env);
  const body = await r.text();
  const csp = r.headers.get("content-security-policy") ?? "";
  check("未解锁只给解锁页", r.status === 200 && body.includes("访问口令") && !body.includes("localStorage"));
  check("解锁页 CSP 收紧", csp.includes("default-src 'none'") && csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"));
}

/* ── 访问口令 ───────────────────────────────────────────── */
{
  const r = await worker.fetch(req("/hg/unlock", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    body: "key=wrong",
  }), env);
  check("错误口令 → 303 且不下发 Cookie", r.status === 303 && r.headers.get("location") === "/?err=1" && !r.headers.get("set-cookie"));
}
let cookie = "";
{
  const r = await worker.fetch(req("/hg/unlock", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
    body: `key=${encodeURIComponent(KEY)}`,
  }), env);
  const raw = r.headers.get("set-cookie") ?? "";
  cookie = raw.split(";")[0];
  check("正确口令 → 303 + HttpOnly/Secure/Lax Cookie",
    r.status === 303 && r.headers.get("location") === "/"
    && /HttpOnly/.test(raw) && /Secure/.test(raw) && /SameSite=Lax/.test(raw)
    && cookie.startsWith("hg_access=") && cookie.length > 20);
}

/* ── 同源校验与 RPC 信封 ────────────────────────────────── */
{
  const r = await worker.fetch(post("/hg/rpc", { cmd: "line_mirrors" }), env);
  check("未解锁 RPC → 401", r.status === 401);
}
{
  const r = await worker.fetch(post("/hg/rpc", { cmd: "line_mirrors" }, { origin: "https://evil.example", cookie }), env);
  check("跨站 Origin RPC → 403", r.status === 403);
}
{
  // line_mirrors 是纯本地命令，不会触发上游 fetch
  const r = await worker.fetch(post("/hg/rpc", { cmd: "line_mirrors" }, { cookie }), env);
  const j = await r.json();
  check("同源 RPC 返回 channel/api/data", r.status === 200 && j.channel === "h5" && j.api === 1 && j.data?.source === "h5");
}
{
  const r = await worker.fetch(post("/hg/rpc", { cmd: "no_such_cmd" }, { cookie }), env);
  check("未知命令 → 400 JSON", r.status === 400 && !!(await r.json()).error);
}

/* ── 静态资源与安全头 ───────────────────────────────────── */
{
  const r = await worker.fetch(req("/", { headers: { cookie } }), env);
  const body = await r.text();
  const csp = r.headers.get("content-security-policy") ?? "";
  check("解锁后返回业务 HTML", body.includes("localStorage"));
  check("业务 HTML CSP 含内联脚本 hash", csp.includes("script-src 'self' 'sha256-"));
  check("业务 HTML no-store", r.headers.get("cache-control") === "no-store");
}
{
  const r = await worker.fetch(req("/assets/app.js", { headers: { cookie } }), env);
  check("静态 JS 长缓存", (r.headers.get("cache-control") ?? "").includes("max-age=31536000"));
}

/* ── SSRF 与未知路由 ────────────────────────────────────── */
{
  const r = await worker.fetch(req(`/hg/seg?u=${encodeURIComponent("http://127.0.0.1/x")}`, { headers: { cookie } }), env);
  check("私网目标 → 400 且不发起上游请求", r.status === 400);
}
{
  const r = await worker.fetch(req(`/hg/seg?u=${encodeURIComponent("http://hg.localhost/x")}`, { headers: { cookie } }), env);
  check("内部协议主机名 → 400", r.status === 400);
}
{
  const r = await worker.fetch(req("/hg/unknown", { headers: { cookie } }), env);
  check("未知 /hg 路径 → 404", r.status === 404);
}

/* ── 媒体缓存：写入失败不得重复回源，且写入要走后台任务 ── */
{
  const savedFetch = globalThis.fetch;
  const savedCaches = globalThis.caches;
  let fetches = 0;
  const tasks = [];
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response("0123456789", {
      status: 200,
      headers: { "content-type": "video/mp2t", "content-length": "10" },
    });
  };
  globalThis.caches = {
    open: async () => ({
      match: async () => undefined,
      put: async () => { throw new Error("cache write failed"); },
    }),
  };
  try {
    const r = await worker.fetch(
      req(`/hg/seg?u=${encodeURIComponent("https://cdn.example.com/seg.ts")}`, { headers: { cookie } }),
      env,
      { waitUntil: (task) => tasks.push(task) },
    );
    check("缓存写入失败仍返回分片", r.status === 200 && (await r.text()) === "0123456789");
    check("缓存写入失败不重复回源", fetches === 1);
    check("缓存写入交给 waitUntil 后台执行", tasks.length === 1);
    await Promise.allSettled(tasks);
  } finally {
    globalThis.fetch = savedFetch;
    globalThis.caches = savedCaches;
  }
}

if (failed) {
  console.error(`H5 Worker 冒烟测试失败（${failed} 项）`);
  process.exit(1);
}
console.log(`H5 Worker 冒烟测试通过：探针 / 解锁 / 同源 / CSP / SSRF 共 ${total} 项断言`);
