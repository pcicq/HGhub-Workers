# 跨平台 Workers 标准化契约

**结论**：H5 的核心 handler 已经是 WinterTC（ECMA TC55，前 WinterCG）形态的 `fetch(request, env) -> Response`，业务逻辑不依赖 Cloudflare 专有 API。平台差异只有 **2 个必需能力**（读配置、取静态资源）和 **1 个可选能力**（边缘缓存），已收敛到 `workers/src/platform.ts` 的 `PlatformAdapter`。接非 Cloudflare 平台时核心代码零改动，只需实现一个适配器 + 一个薄入口 + 平台路由配置；Cloudflare Pages 与 Workers 共用 `env.ASSETS` 语义，属于同一运行时的换入口，见下文。

> 合规边界见 [README 顶部警示](../README.md) 与 [h5-channel.md](./h5-channel.md)：禁止在中国大陆下载、传播本软件及相关资源，禁止商业用途。多平台部署会放大暴露面，请勿据此把站点公开化。

## 统一层（已在仓库落地）

| 层 | 统一约定 | 位置 |
| --- | --- | --- |
| 入口 | `default.fetch(request, env)` | `workers/src/index.ts` |
| env 契约 | `Env` / `PlatformAdapter` | `workers/src/policy.ts`、`workers/src/platform.ts` |
| 配置名 | `H5_ACCESS_KEY`、`H5_ALLOWED_ORIGIN`、`H5_EXTRA_BASES` | `workers/src/platform.ts` 的 `createEnv()` |
| 产物 | 唯一一份 `dist/`，由 Worker Assets 托管；CF Pages 复用副本 `pages-dist/`，ESA 静态目录为去掉 `index.html` 的 `esa-static/` | `h5:build`、`h5:pages:build` |
| 质量门禁 | `h5:ci` = Worker tsc + 契约校验 + 53 项冒烟 + 前端构建 | `package.json`、`.github/workflows/ci.yml` 的 `h5` job |
| 部署命令 | Workers 用 `h5:deploy` / `h5:preview`；CF Pages 用 `h5:pages:deploy`，内部固定 `wrangler@4`；ESA 走控制台 Git 集成，无部署脚本 | `package.json` |
| 安全策略 | 口令 + 同源 + 加密 Cookie + SSRF 校验 + CSP | Worker 内部，与平台无关 |

`h5:ci` 不部署、不需要任何凭据，任何云平台的接入流水线都可以先复用这一份门禁和同一份 `dist/`。

## 平台绑定点（只有三处）

| 绑定点 | 位置 | 为什么平台相关 | 收敛方式 |
| --- | --- | --- | --- |
| 运行时配置 | `policy.ts`、`rpc.ts`、`index.ts` 读 `env.H5_*` | CF 是 env 绑定，Deno 是 `Deno.env`，Node/Bun 是 `process.env` | `createEnv({ get })` |
| 静态资源 | `index.ts` 的 `env.ASSETS.fetch()` | CF Workers 由 `[assets]` 绑定、Pages 默认注入；其它平台没有这个绑定，且解锁页/CSP 要求「所有请求先过函数」 | `createEnv({ fetchAsset })`（仅非 CF 平台需要） |
| 边缘缓存 | `media.ts` 的 `caches.open()` | Cache API 不属于 WinterTC Minimum Common API | 已包在 `try/catch` 里，缺失时自动回源，**功能不受影响**，只是上游请求变多 |

其余用到的全是 Web 标准 API：`fetch`、`Request`/`Response`/`Headers`、`FormData`、`URL`/`URLSearchParams`、`TextEncoder`/`TextDecoder`、`crypto.subtle`（HMAC、AES-GCM、AES-CBC、SHA-256）、`crypto.getRandomValues`、Streams、`setTimeout`、`console`。

> ⚠️ `policy.ts` 还用了 `btoa`/`atob`。主流边缘运行时都提供，但它们**不在 WinterTC Minimum Common API 清单里**；接入某个平台前先确认，缺失时补一个 base64 polyfill 即可，只影响编码辅助函数。

## 接入模板

`workers/src/index.ts` 同时导出 `createEnv`，任何平台都能这样复用同一个 handler：

```ts
import worker, { createEnv } from "../workers/src/index";

const env = createEnv({
  get: (name) => platformGetSecret(name),          // 换成该平台读环境变量的方式
  fetchAsset: (request) => platformFetchAsset(request), // 从 dist/ 或平台静态托管取文件
});

// Deno Deploy
Deno.serve((request) => worker.fetch(request, env));

// Bun
// Bun.serve({ port: 8787, fetch: (request) => worker.fetch(request, env) });

// Vercel / Netlify / 其它：按平台要求把上面的 fetch 函数作为 handler 导出，
// 并在平台路由配置里把 /* 指向该函数（等价于 run_worker_first）。
```

`createEnv` 在缺少 `H5_ACCESS_KEY` 时会填空串，此时 `/hg/health` 返回 503——和其它平台上的「未配置」语义一致，能防止网关误判可用。`scripts/test-h5-worker.mjs` 里已用这个适配器跑通探针与解锁页断言，证明核心 handler 不绑定 CF 专有 API。

## 各平台差异

| 平台 | fetch 入口 | 配置来源 | 静态资源方案 | 路由要求 | 本仓库状态 |
| --- | --- | --- | --- | --- | --- |
| Cloudflare Workers | `export default { fetch }` | env 绑定 / `wrangler secret` | `ASSETS` + `run_worker_first = true` | `workers/wrangler.toml` | ✅ 已验证（`deploy --dry-run` + 53 项冒烟） |
| Cloudflare Pages（advanced mode） | `pages-dist/_worker.js` 的 `export default { fetch }` | Pages 环境变量 / `pages secret put` | 默认 `env.ASSETS` 绑定，无需配置 | 全量接管，忽略 `/functions` 与 `_routes.json` | 本地已验证产物形状与探针；CLI 部署未实机执行 |
| 阿里云 ESA 函数和 Pages | `pages-dist/esa-worker.js` 的 `export default { fetch(request, context, env) }` | 函数变量（可加密存储），运行时经 `env` 读取 | ESA 静态托管优先；业务 HTML 内联进函数，`esa-static/` 不含 `index.html` | 静态优先，无 `run_worker_first` 等价开关；单次执行最多 4 个 `fetch` | 本地已验证参数换位、解锁页与业务 HTML；控制台部署未实机执行 |
| Deno Deploy | `Deno.serve()` | `Deno.env.get()` | 自行读 `dist/` 或外置对象存储 | 把 `/*` 指向函数 | 契约已备，未实机验证 |
| Vercel（Fluid Compute / Functions） | 平台 handler 导出 | `process.env` | 平台静态托管 + rewrites | 需 `/*` rewrite 到函数 | 契约已备，未实机验证 |
| Netlify Edge Functions | `export default` + `config` | `Deno.env` / 平台环境变量 | 平台静态托管 + redirects | 需 `/*` redirect 到函数 | 契约已备，未实机验证 |
| Node.js / Bun 自建 | `serve({ fetch })` / `Bun.serve()` | `process.env` | 从 `dist/` 读文件，需自己防目录穿越 | 反向代理指向进程 | 契约已备，未实机验证 |
| 国内云边缘函数（EdgeOne 类等） | 平台专有 handler | 平台环境变量 | 平台静态托管 / 对象存储 | 平台路由配置 | 契约已备，未实机验证；**需先确认 Web Crypto 是否支持 AES-GCM 与 AES-CBC** |

> 说明：Vercel 已把 Edge Functions 并入 Fluid Compute / Functions 体系，接入时以该平台当前的 handler 导出规范为准。

## Cloudflare Pages 兼容（advanced mode）

**结论**：Pages 与 Workers 跑同一个 Workers runtime。`_worker.js` 官方要求 Module Worker 语法、全量接管请求、默认提供 `env.ASSETS.fetch()`，等价于本仓库的 `run_worker_first = true` + `ASSETS` 绑定。因此兼容成本只有「换一个输出目录 + 把同一个入口打包成单文件」，核心 handler、53 项冒烟与 `h5:ci` 全部复用，**业务代码零改动，也不需要 `createEnv` 适配器**（Pages 直接注入 `env.ASSETS`）。

| 项 | Workers 链路 | Pages 链路 |
| --- | --- | --- |
| 输出目录 | `dist/` | `pages-dist/`（`dist/` 的副本 + `_worker.js`） |
| 入口 | `workers/wrangler.toml` → `workers/src/index.ts` | `pages-dist/_worker.js`（同一入口的 esbuild bundle） |
| 静态资源 | `[assets]` + `ASSETS` | 默认 `env.ASSETS`，无需绑定配置 |
| 路由 | `run_worker_first = true` | advanced mode 天然全量接管；`/functions`、`_routes.json` 均被忽略 |
| 口令 | `wrangler secret put` | `wrangler pages secret put H5_ACCESS_KEY --project-name <项目名>` |
| 部署 | `h5:deploy` | `h5:pages:deploy` |

**本地构建与自检**（不联网、不部署）：

```sh
corepack pnpm h5:pages:build    # = h5:build + 复制 dist + 打包 CF/ESA 两套入口 + 形状/探针自检
```

`scripts/build-pages.mjs` 分别自检两套入口：CF 校验 `default.fetch` 与 `/hg/health`（缺口令 503 / 带口令响应形状）；ESA 按 `fetch(request, context, env)` 调用，校验 health、未解锁的解锁页与 CSP、以及真实解锁后返回内联业务 HTML。任一不符 `exit 1`。判据：输出 `[pages] CF ...` 与 `[pages] ESA ...` 两行，且 `diff -rq dist pages-dist --exclude=_worker.js --exclude=esa-worker.js` 无差异。`dist/` 不被写入任何入口文件，Workers 链路不受影响；Vite content hash 变化留下的旧文件会在每次构建时自动清理，保证 `pages-dist/` 始终是 `dist/` 的镜像。

**Pages 项目侧三项配置**（本仓库只给命令，不代为执行）：

1. 创建项目：`npx --yes wrangler@4 pages project create <项目名>`；若走 Git 集成，Build command 填 `corepack pnpm h5:pages:build`，Build output directory 填 `pages-dist`。
2. 写口令：`npx --yes wrangler@4 pages secret put H5_ACCESS_KEY --project-name <项目名>`。不要写进 `[vars]` 或提交。
3. `Settings → Functions` 把 Compatibility date 设为 `2026-11-15`（与 `workers/wrangler.toml` 一致）；旧的 compat date 会改变多值 `Set-Cookie` 等运行时行为，可能让访问/会话 Cookie 丢失。

本地联调 `corepack pnpm h5:pages:dev`（需先 `cp workers/.dev.vars.example workers/.dev.vars` 填自己的口令），然后按 [h5-channel-deploy.md](./h5-channel-deploy.md) 步骤 6 的部署后判据逐项验证。若所用 wrangler 不识别 `--env-file`，改用 `--binding H5_ACCESS_KEY=<本地口令>`（仅本地执行，不要写进仓库）；`pages deploy` 默认会对自包含的 `_worker.js` 再打一次包，报打包错误时可加 `--no-bundle`。

> 本仓库只在本地验证了 `_worker.js` 的 Module Worker 形状与 handler 探针；**`pages deploy` 与 Git 集成部署未实机执行**，命令与 Dashboard 路径以 Cloudflare 当前文档为准。两条链路不要绑定同一个自定义域名，也不要同时作为生产来源。

## 阿里云 ESA 函数和 Pages

**结论**：ER 函数同样是 `export default { fetch }` 语法，但有 **3 处硬差异**，Cloudflare 的「一个 bundle 全接管」不能照搬。

| 差异 | ESA 行为 | 本仓库的收敛方式 |
| --- | --- | --- |
| 参数顺序 | `fetch(request, context, env)`，env 是**第三**个参数 | `workers/esa-entry.js` 薄入口换位后调 `default.fetch(request, env)`；不传 `context`（它没有 `waitUntil`） |
| 静态资源 | 静态优先，命中静态文件就直接返回，**没有 ASSETS 绑定** | `esa-static/` 只放 `assets/` 与 `logo.svg`，业务 HTML 内联进函数，由原 `serveAsset` 注入 CSP 后返回 |
| 子请求 | 单次执行最多 4 个 `fetch`，且 ER 内不能 fetch 另一个 ER 域名 | `fetchAsset` 不发起网络请求；RPC / 媒体每次 1–2 个 fetch 可用，线路探测超限见下 |

**控制台表单怎么填**（`esa.jsonc` 优先级高于控制台；本仓库没有该文件，控制台配置生效）：

| 字段 | 填值 |
| --- | --- |
| 生产分支 | `master`（与仓库一致） |
| 安装命令 | `npm install`（项目脚本内部用 `npm run`，能跑）；要与 CI 完全一致用 `corepack pnpm install --frozen-lockfile` |
| 构建命令 | **`npm run h5:pages:build`**（不是 `h5:build`） |
| 根目录 | `/` |
| 静态资源目录 | **`./esa-static`**（不能填 `./dist`，否则 `index.html` 会绕过解锁页） |
| 函数文件路径 | **`./pages-dist/esa-worker.js`** |
| Node.js 版本 | `22.x` |
| 函数变量 | `H5_ACCESS_KEY`，勾选「加密存储」；可选 `H5_ALLOWED_ORIGIN`、`H5_EXTRA_BASES` |

> 函数变量绑定版本快照：新增或修改后必须重新生成版本并发布，线上函数才读得到新值。
>
> 不要配置 `assets.notFoundStrategy`（含 `singlePageApplication`）：官方说明配了它之后，带 `Sec-Fetch-Mode: navigate` 的导航请求不会触发 ER 函数，`/` 就拿不到解锁页。保持默认模式，静态未命中的请求才会落到函数。

**部署后判据**：

1. 构建日志出现 `[pages] ESA pages-dist/esa-worker.js ...`，且 `esa-static/` 里没有 `index.html`。
2. 未登录访问 `/` 应看到「访问口令」解锁页，**不是业务页面也不是 404**——这条不成立就说明 ESA 对根路径不落到函数，本方案不能用。
3. `/hg/health` 返回 `channel: "h5"`；未配 `H5_ACCESS_KEY` 时返回 503。
4. 输入口令后 303 回到 `/`，返回业务 HTML 且响应头带 `Content-Security-Policy`；`/assets/*`、`/logo.svg` 返回 200。
5. 按 [h5-channel-deploy.md](./h5-channel-deploy.md) 步骤 6 逐项验证媒体与登录态。

**明确降级，不要当成完整兼容**：

- `line_probe` 最多 24 个、`line_auto` 最多 11 个、`line_mirrors` 最多 4 个上游请求，必然撞 4 个子请求上限；浏览 / 搜索 / 播放主流程每次 1–2 个 fetch 可用。要恢复线路能力需把 `rpc.ts` 的 `PROBE_MAX` / `PROBE_CHUNK` 调到 ≤3，属于业务代码改动，本轮未做。
- 静态 JS/CSS 由 ESA 直出，Worker 不会给这些响应加 CSP 与安全头；HTML 仍由函数返回并注入。
- 官方 runtime API 列有 `Crypto` / `SubtleCrypto` 与 Streams / Fetch / `atob` / `btoa` / `setTimeout`，但 **AES-CBC 是否支持、多值 `Set-Cookie`、CPU 时间片（5/50/100 ms）、10 秒网关等待均未实机确认**；`caches.open` 缺失会由 `withCache` 的 try/catch 降级为每次回源。
- 代码包上限 4 MB，本产物约 66 KB，未逼近；控制台部署未实机执行。

## 明确边界（不提供半成品）

- 本仓库**只提供 Cloudflare Workers、Cloudflare Pages（advanced mode）与阿里云 ESA 函数和 Pages 三条链路**；不生成 `vercel.json`、`netlify.toml`、`deno.json` 等未经实机验证的平台配置——放进去却不能跑，比不放更糟。CF Pages 与 Workers 共用 `env.ASSETS` 语义，不需要 `createEnv` 适配器；ESA 是唯一需要薄入口 + `createEnv` 的一条。
- 要真正接入**其它**平台，最小改动是三件：实现 `get` 与 `fetchAsset`、写一个约 15 行的薄入口、配一条把所有路径指向函数的路由。**核心逻辑零改动**，`h5:ci` 可直接复用。
- 三个硬前提，缺一不可：
  1. **所有请求（含 HTML）必须先经过函数**。解锁页与 CSP 注入依赖这一点；若平台静态资源优先于函数，未解锁用户会直接拿到业务 JS。ESA 是唯一例外：把业务 HTML 移出静态目录、改由函数内联返回，静态 JS/CSS 仍由平台直出且不带 CSP，已在 ESA 小节标为降级。
  2. **运行时必须支持 Web Crypto 的 AES-GCM**（会话/线路 Cookie 加解密）**与 AES-CBC**（封面解密），以及流式 `Response` body 与 Range 透传。
  3. **线路命令会并发发起到外部站点的请求**：`line_mirrors` 最多 4 个子请求，`line_probe` 最多 24 个，`line_auto` 最多 11 个，靠 `AbortController` + `setTimeout` 做 8 秒 / 5 秒超时。接平台前确认它的出站请求配额、并发限制与定时器语义；配额低的平台按 `workers/src/rpc.ts` 的 `PROBE_MAX` / `PROBE_CHUNK` 调小，别整段删掉超时。

## 风险标注

- **【高风险】合规 — 位置：多平台部署；影响：暴露面随平台数量放大，与 README 的大陆传播限制、非商业许可冲突；建议：仅个人自用，每个平台都强制访问口令与来源限制，不公开分享地址。**
- **【中风险】`fetchAsset` 实现 — 位置：非 CF 平台适配器；影响：若直接按请求路径读本地文件，可能造成目录穿越读到仓库其它文件；建议：只允许 `dist/` 内的规范化路径，禁止 `..`，未知路径回退 `index.html`。**
- **【中风险】缓存能力缺失 — 位置：`media.ts` 的 `withCache`；影响：无 Cache API 的平台每次 `img`/`seg` 都回源，上游压力与流量成本上升；建议：接平台时优先接它的边缘缓存或 CDN。**
- **【中风险】运行时行为差异 — 位置：多值 `Set-Cookie`、流式 body、Range/206；影响：播放器可能出现黑屏或登录态丢失；建议：每接一个平台都跑一遍 [h5-channel-deploy.md](./h5-channel-deploy.md) 步骤 6 的部署后验证判据。**
- **【中风险】契约漂移 — 位置：`scripts/test-h5-rpc-coverage.mjs`；影响：只校验命令名与常量，不校验参数形状；建议：上游 `api.rs` 变更后人工回归登录与互动流程。**
- **【中风险】兼容日期 — 位置：Pages 项目 `Settings → Functions`；影响：旧 compatibility date 会改变多值 `Set-Cookie` 等运行时行为，访问/会话 Cookie 可能丢失；建议：与 `workers/wrangler.toml` 的 `2026-11-15` 保持一致后重跑部署后验证。**
- **【中风险】双链路并存 — 位置：Workers 与 Pages 同时部署；影响：同域名互相覆盖或流量打到未更新的一侧；建议：只保留一条生产链路，另一条仅作兼容性验证。**
- **【高风险】合规 — 位置：阿里云 ESA 国内边缘节点；影响：README 顶部明确禁止在中国大陆下载、复制、分享、传播本软件及相关资源，非商业许可同样限制公开部署，国内节点分发会放大暴露面；建议：部署前自行判断并承担合规责任，仅个人自用，不公开地址、不传播接口与直链。**
- **【高风险】4 个子请求上限 — 位置：ESA ER 单次执行 / `rpc.ts` 的 `PROBE_MAX`、`PROBE_CHUNK`；影响：线路探测（24）、自动选线（11）、镜像线路（4）必然失败，前端可能报错；建议：只依赖浏览 / 搜索 / 播放主流程，或把两个常量调到 ≤3 后重跑 `h5:ci`。**
- **【中风险】根路径路由 — 位置：ESA 静态优先 + `esa-static/` 不含 `index.html`；影响：若 ESA 对 `/` 不落到函数而是直接 404 或自动映射 `index.html`，解锁页与 CSP 全部失效；建议：以 ESA 部署后判据第 2 条为首验项，不通过立即停用该链路。**

## 与 GitHub 链路的关系

```
GitHub 仓库（唯一源）
   ├─ .github/workflows/ci.yml → h5:ci        统一门禁，不部署、无凭据
   ├─ Cloudflare Workers Builds   → h5:deploy        CF 生产（截图那条路）
   ├─ Cloudflare Pages (advanced) → h5:pages:build   可选兼容链路，pages-dist/
   ├─ 阿里云 ESA 函数和 Pages     → h5:pages:build   esa-static/ + esa-worker.js
   └─ 其它云平台流水线           → 复用 dist/ + createEnv() 适配器
```

从 GitHub 拉取部署的完整步骤见 [h5-channel-deploy.md](./h5-channel-deploy.md) 文末的「方式 B」章节。

*平台能力与 WinterTC 基线核对于 2026-11-15，wrangler 4.162.0；Pages advanced mode 依据 Cloudflare 官方文档（2026-04-21 更新）、ESA 构建与路由 / 函数变量 / runtime API 依据阿里云帮助中心（2026-11-13、2026-10-15 更新）核对。*
