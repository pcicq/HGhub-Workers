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
  // line_state 是纯本地命令，不会触发上游 fetch
  const r = await worker.fetch(post("/hg/rpc", { cmd: "line_state" }, { cookie }), env);
  const j = await r.json();
  check("同源 RPC 返回 channel/api/data", r.status === 200 && j.channel === "h5" && j.api === 1 && j.data?.fixed?.length === 1);
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

/* ── 媒体缓存与分片直透：对齐 media.rs，流式分片绝不 clone 进 Cache API ── */
{
  const savedFetch = globalThis.fetch;
  const savedCaches = globalThis.caches;
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  let fetches = 0;
  let cacheOpens = 0;
  let signalSeen = false;
  const tasks = [];
  globalThis.fetch = async (input, init) => {
    fetches += 1;
    if (init?.signal instanceof AbortSignal) signalSeen = true;
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname.endsWith(".m3u8")) {
      return new Response("#EXTM3U\n#EXT-X-TARGETDURATION:4\nhttps://cdn.example.com/1.ts\n", {
        status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" },
      });
    }
    if (url.pathname.endsWith(".jpg")) {
      return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    return new Response("0123456789", {
      status: 200, headers: { "content-type": "video/mp2t", "content-length": "10" },
    });
  };
  globalThis.caches = {
    open: async () => {
      cacheOpens += 1;
      return {
        match: async () => undefined,
        put: async () => { throw new Error("cache write failed"); },
      };
    },
  };
  const mediaCtx = { waitUntil: (task) => tasks.push(task) };
  try {
    // 封面：完整缓冲在内存，缓存写失败只降级，不二次回源
    const img = await worker.fetch(
      req(`/hg/img?u=${encodeURIComponent("https://cdn.example.com/cover.jpg")}`, { headers: { cookie } }),
      env, mediaCtx,
    );
    check("封面缓存写失败仍返回图片", img.status === 200 && (await img.arrayBuffer()).byteLength === jpeg.length);
    check("封面缓存写失败不重复回源", fetches === 1);
    check("封面缓存写入交后台任务", tasks.length === 1);
    await Promise.allSettled(tasks);

    // 分片：流式直透，不 tee、不进 Cache API；浏览器靠 Cache-Control 自己缓存
    const before = { fetches, cacheOpens, tasks: tasks.length };
    const seg = await worker.fetch(
      req(`/hg/seg?u=${encodeURIComponent("https://cdn.example.com/seg.ts")}`, { headers: { cookie } }),
      env, mediaCtx,
    );
    check("分片流式直透", seg.status === 200 && (await seg.text()) === "0123456789");
    check("分片只回源一次", fetches === before.fetches + 1);
    check("分片不触碰 Cache API", cacheOpens === before.cacheOpens);
    check("分片不产生缓存后台任务", tasks.length === before.tasks);
    check("分片给浏览器 1 小时缓存", (seg.headers.get("cache-control") ?? "").includes("max-age=3600"));

    // 子清单：继续改写 URI，并恢复上游审计确认的 1 小时缓存
    const sub = await worker.fetch(
      req(`/hg/seg?u=${encodeURIComponent("https://cdn.example.com/sub.m3u8")}`, { headers: { cookie } }),
      env, mediaCtx,
    );
    const subBody = await sub.text();
    check("子清单 URI 继续改写", sub.status === 200 && subBody.includes("/hg/seg?u=")
      && !subBody.includes("https://cdn.example.com/1.ts"));
    check("子清单恢复 1 小时缓存", (sub.headers.get("cache-control") ?? "").includes("max-age=3600"));
    check("出站请求带超时 signal", signalSeen);
  } finally {
    globalThis.fetch = savedFetch;
    globalThis.caches = savedCaches;
  }
}

/* ── 线路：自定义 / 发布页镜像 / 自动选线全链路（全部 mock fetch） ── */
const call = (cmd, args = {}, lineCookie = "") => worker.fetch(
  post("/hg/rpc", { cmd, args }, { cookie: lineCookie ? `${cookie}; ${lineCookie}` : cookie }),
  env,
);
const readCookies = (r) => {
  if (typeof r.headers.getSetCookie === "function") return r.headers.getSetCookie();
  const raw = r.headers.get("set-cookie");
  return raw ? [raw] : [];
};
const pickCookie = (r, name) => readCookies(r)
  .map((raw) => raw.split(";")[0])
  .find((part) => part.startsWith(`${name}=`)) ?? "";
const withFetch = async (handler, fn) => {
  const saved = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = saved; }
};
const FEED = JSON.stringify({
  status: 1,
  data: { items: [{ id: 1, title: "video" }], pagination: { page: 1, pages: 1, size: 1, total: 1 } },
});
const publishHtml = (src) => new Response(`<html><script src="${src}"></script></html>`, {
  status: 200, headers: { "content-type": "text/html; charset=utf-8" },
});
const publishFetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.pathname === "/" && url.hostname.endsWith(".pages.dev")) return publishHtml("/publish.js?v=2");
  if (url.pathname === "/publish.js") {
    return new Response(
      "/* before */ var urls = ['a.example','b.example',]; const subdomains = ['one', 'two'];",
      { status: 200, headers: { "content-type": "application/javascript" } },
    );
  }
  return new Response(FEED, { status: 200, headers: { "content-type": "application/json" } });
};
const offlineFetch = async () => { throw new Error("offline"); };

{
  const r = await call("line_state");
  const j = await r.json();
  check("线路状态含一条固定线路且默认非自定义",
    r.status === 200 && j.data.base === "https://huangguoai.com"
    && j.data.custom === false && j.data.fixed.length === 1);
}

let customLineCookie = "";
{
  const r = await call("line_custom_set", { url: "https://Mirror.Example.com/" });
  const j = await r.json();
  customLineCookie = pickCookie(r, "hg_line");
  check("自定义线路保存并规整为 HTTPS origin",
    r.status === 200 && j.data.base === "https://mirror.example.com" && j.data.custom === true);
  check("切换线路下发加密线路 Cookie 并清空会话凭据",
    customLineCookie.length > 20 && readCookies(r).some((raw) => raw.startsWith("hg_session=;")));
}
{
  const r = await call("line_state", {}, customLineCookie);
  const j = await r.json();
  check("加密线路 Cookie 在后续请求恢复",
    r.status === 200 && j.data.base === "https://mirror.example.com" && j.data.custom === true);
}
{
  const r = await call("line_reset", {}, customLineCookie);
  const j = await r.json();
  check("恢复主站清除自定义标记", r.status === 200 && j.data.base === "https://huangguoai.com" && j.data.custom === false);
}
for (const [name, url] of [
  ["私网 IP 自定义线路被拒绝", "https://127.0.0.1/"],
  ["内网主机名自定义线路被拒绝", "https://x.local/"],
  ["HTTP 自定义线路被拒绝", "http://mirror.example.com/"],
  ["带路径的自定义线路被拒绝", "https://mirror.example.com/api"],
  ["带认证信息的自定义线路被拒绝", "https://u:p@mirror.example.com/"],
]) {
  const r = await call("line_custom_set", { url });
  check(name, r.status === 400);
}
await withFetch(offlineFetch, async () => {
  const r = await call("line_set", { url: "https://not-published.example" });
  check("未发布的线路不能隐式切换", r.status === 400);
});
await withFetch(publishFetch, async () => {
  const r = await call("line_mirrors");
  const j = await r.json();
  check("镜像列表来自两个发布页且去重交错",
    r.status === 200 && j.data.items.length === 4 && j.data.items[0].url === "https://one.a.example");
  check("推荐镜像把当前线路置于首位",
    j.data.recommended[0].url === "https://huangguoai.com" && j.data.recommended.length > 1);
  check("发布源信息回传", j.data.source.includes("huangguoai.pages.dev")
    && j.data.source.includes("huang-guo.pages.dev"));
  const s = await call("line_set", { url: "https://one.a.example" });
  check("已发布镜像可直接切换", s.status === 200 && (await s.json()).data === "https://one.a.example");
});
{
  const evilFetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/" && url.hostname.endsWith(".pages.dev")) return publishHtml("/publish.js");
    if (url.pathname === "/publish.js") {
      return new Response(
        "var urls=['good.example']; var urls=['evil.example'];",
        { status: 200, headers: { "content-type": "application/javascript" } },
      );
    }
    return new Response(FEED, { status: 200, headers: { "content-type": "application/json" } });
  };
  await withFetch(evilFetch, async () => {
    const r = await call("line_mirrors");
    check("重复声明的发布脚本失败关闭", r.status === 400);
  });
  await withFetch(async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/" && url.hostname.endsWith(".pages.dev")) {
      return publishHtml("https://evil.example/publish.js");
    }
    return new Response(FEED, { status: 200, headers: { "content-type": "application/json" } });
  }, async () => {
    const r = await call("line_mirrors");
    check("跨 origin 发布脚本被拒绝", r.status === 400);
  });
}
await withFetch(publishFetch, async () => {
  const p = await call("line_probe", { urls: ["https://a.example", "https://b.example"] });
  const pj = await p.json();
  check("线路探测走真实内容接口判据",
    p.status === 200 && pj.data.length === 2 && pj.data[0].ok === true && pj.data[0].reachable === true);

  const a = await call("line_auto");
  const aj = await a.json();
  check("自动选线主站可用时优先主站",
    a.status === 200 && aj.data.cancelled === false && aj.data.pick.reason === "main-ok"
    && aj.data.pick.base === "https://huangguoai.com");

  const t = await call("line_try_main");
  const tj = await t.json();
  check("回切主站探测可用", t.status === 200 && tj.data.probe.ok === true && tj.data.probe.tier === "main");

  const h = await call("line_health");
  const hj = await h.json();
  check("线路体检返回当前线路", h.status === 200 && hj.data.ok === true && hj.data.base === "https://huangguoai.com");
});
await withFetch(offlineFetch, async () => {
  const r = await call("line_auto");
  const j = await r.json();
  check("全部探测失败时保持当前线路",
    r.status === 200 && j.data.pick.reason === "all-down" && j.data.switched === false
    && j.data.base === "https://huangguoai.com");
});

if (failed) {
  console.error(`H5 Worker 冒烟测试失败（${failed} 项）`);
  process.exit(1);
}
console.log(`H5 Worker 冒烟测试通过：探针 / 解锁 / 同源 / CSP / SSRF / 媒体缓存 / 线路 共 ${total} 项断言`);
