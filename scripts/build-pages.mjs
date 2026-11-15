/**
 * Pages 产物构建：同一份 dist/ 同时产出 Cloudflare Pages 与阿里云 ESA 两套入口。
 *
 * CF：_worker.js 全量接管请求且默认注入 env.ASSETS，等价于 run_worker_first = true，
 *     业务逻辑零改动。
 * ESA：静态资源优先、没有 ASSETS 绑定、env 是 fetch 的第三个参数，因此增加
 *     workers/esa-entry.js 薄入口，并把业务 HTML 内联，避免 "/" 绕过解锁页。
 *
 *   pages-dist/  ← dist/ 的镜像 + _worker.js（CF）+ esa-worker.js（ESA 函数入口）
 *   esa-static/  ← dist/ 去掉 index.html（ESA 静态托管目录）
 * 全程不联网、不部署；产物形状或能力探针不符直接 exit 1。
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const out = join(root, "pages-dist");
const esaOut = join(root, "esa-static");

const fail = (message) => {
  console.error(`[pages] ${message}`);
  process.exit(1);
};

if (!existsSync(join(dist, "index.html"))) {
  fail("找不到 dist/index.html，请先执行 npm run h5:build");
}

// pnpm 9/10/12 的 esbuild 位置不同，与 test-h5-worker.mjs 保持同一套查找顺序
const esbuild = [
  join(root, "node_modules/.bin/esbuild"),
  join(root, "node_modules/esbuild/bin/esbuild"),
  join(root, "node_modules/.pnpm/node_modules/esbuild/bin/esbuild"),
].find((path) => existsSync(path));
if (!esbuild) {
  fail("找不到 esbuild，请先执行 corepack pnpm install --frozen-lockfile");
}

// 不做整目录递归删除：只覆盖同名文件，dist/ 与 Workers 链路完全不受影响。
// Vite 的 assets 带 content hash，源码改动后旧文件会留在 pages-dist/，
// 这里逐个删掉这些陈旧产物，避免把它们一并传上 Pages；删除范围仅限脚本自己的输出目录。
const listFiles = (dir, prefix = "") => readdirSync(dir, { withFileTypes: true })
  .flatMap((entry) => entry.isDirectory()
    ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]);

mkdirSync(out, { recursive: true });
cpSync(dist, out, { recursive: true, force: true });
const expected = new Set(listFiles(dist));
const generated = new Set(["_worker.js", "esa-worker.js"]);
const stale = listFiles(out).filter((name) => !generated.has(name) && !expected.has(name));
for (const name of stale) unlinkSync(join(out, name));

// ESA 静态目录 = dist 去掉 index.html。业务 HTML 由函数内联返回，
// 否则 ESA 静态优先会把 "/" 直接交给未解锁访客，解锁页与 CSP 注入失效。
mkdirSync(esaOut, { recursive: true });
cpSync(dist, esaOut, {
  recursive: true, force: true,
  filter: (source) => basename(source) !== "index.html",
});
const esaExpected = new Set([...expected].filter((name) => name !== "index.html"));
const esaStale = listFiles(esaOut).filter((name) => !esaExpected.has(name));
for (const name of esaStale) unlinkSync(join(esaOut, name));

execFileSync(esbuild, [
  "workers/src/index.ts",
  "--bundle", "--format=esm", "--platform=browser", "--target=es2022",
  "--outfile=pages-dist/_worker.js", "--log-level=error",
], { cwd: root, encoding: "utf8" });

// ESA：薄入口 + 内联 dist/index.html，打成另一个自包含 ESM（text loader 把 html 变字符串）
execFileSync(esbuild, [
  "workers/esa-entry.js",
  "--bundle", "--format=esm", "--platform=browser", "--target=es2022",
  "--loader:.html=text", "--outfile=pages-dist/esa-worker.js", "--log-level=error",
], { cwd: root, encoding: "utf8" });

const workerFile = join(out, "_worker.js");
const esaFile = join(out, "esa-worker.js");
const bundle = await import(`${pathToFileURL(workerFile).href}?t=${Date.now()}`);
const worker = bundle.default;

// advanced mode 强制 Module Worker 语法：export default { fetch }
if (!worker || typeof worker.fetch !== "function") {
  fail("_worker.js 未导出 default.fetch，Pages 无法接管请求");
}
if (typeof bundle.createEnv !== "function") {
  fail("_worker.js 缺少 createEnv 导出，打包入口可能选错");
}

// 能力探针：缺口令必须 503，带口令必须返回 H5 网关形状
const probe = (key) => worker.fetch(
  new Request("https://h5.example.test/hg/health"),
  { H5_ACCESS_KEY: key, ASSETS: { fetch: () => new Response("") } },
);
const missing = await probe("");
if (missing.status !== 503) {
  fail(`缺 H5_ACCESS_KEY 时 /hg/health 应为 503，实际 ${missing.status}`);
}
const healthy = await probe("pages-build-probe");
if (healthy.status !== 200) {
  fail(`带口令时 /hg/health 应为 200，实际 ${healthy.status}`);
}
const info = await healthy.json();
if (info?.channel !== "h5" || info?.auth !== "cookie"
  || typeof info?.api !== "number" || typeof info?.version !== "string") {
  fail(`/hg/health 响应形状异常：${JSON.stringify(info)}`);
}

// ESA 自检：按 fetch(request, context, env) 的参数顺序调用，验证 env 换位与解锁页
const esaBundle = await import(`${pathToFileURL(esaFile).href}?t=${Date.now()}`);
const esaWorker = esaBundle.default;
if (!esaWorker || typeof esaWorker.fetch !== "function") {
  fail("esa-worker.js 未导出 default.fetch");
}
if (existsSync(join(esaOut, "index.html"))) {
  fail("esa-static/ 不应包含 index.html，否则 ESA 静态优先会绕过解锁页");
}
const esaEnv = { H5_ACCESS_KEY: "pages-build-probe" };
const esaHealth = await esaWorker.fetch(
  new Request("https://h5.example.test/hg/health"), {}, esaEnv,
);
if (esaHealth.status !== 200) {
  fail(`ESA 入口 /hg/health 应为 200，实际 ${esaHealth.status}（检查 env 是否为第三参数）`);
}
const esaRoot = await esaWorker.fetch(new Request("https://h5.example.test/"), {}, esaEnv);
const esaHtml = await esaRoot.text();
if (!esaHtml.includes("访问口令") || !esaRoot.headers.get("content-security-policy")) {
  fail("ESA 入口未返回解锁页或缺少 CSP，参数换位 / HTML 内联可能失效");
}

// 走一遍真实解锁流程，验证内联的业务 HTML 与 CSP 注入在 ESA 参数顺序下同样生效
const unlockRes = await esaWorker.fetch(new Request("https://h5.example.test/hg/unlock", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ key: "pages-build-probe" }).toString(),
}), {}, esaEnv);
const accessCookie = unlockRes.headers.get("set-cookie")?.split(";")[0] ?? "";
if (unlockRes.status !== 303 || !accessCookie.startsWith("hg_access=")) {
  fail("ESA 入口解锁失败，未拿到 hg_access Cookie");
}
const home = await esaWorker.fetch(new Request("https://h5.example.test/", {
  headers: { cookie: accessCookie },
}), {}, esaEnv);
const homeHtml = await home.text();
if (!homeHtml.includes('<div id="root">') || !home.headers.get("content-security-policy")) {
  fail("ESA 入口解锁后未返回内联的业务 HTML 或缺少 CSP");
}

if (stale.length) console.log(`[pages] 已清理 ${stale.length} 个陈旧文件`);
console.log(`[pages] CF  pages-dist/_worker.js ${statSync(workerFile).size} B ← dist/ 镜像`);
console.log(`[pages] ESA pages-dist/esa-worker.js ${statSync(esaFile).size} B，静态目录 esa-static/（无 index.html）`);
console.log("[pages] CF  本地验证：npm run h5:pages:dev");
console.log("[pages] CF  部署命令：npm run h5:pages:deploy（先改 --project-name 为实际项目名）");
console.log("[pages] ESA 控制台：静态资源目录 ./esa-static，函数文件路径 ./pages-dist/esa-worker.js");
