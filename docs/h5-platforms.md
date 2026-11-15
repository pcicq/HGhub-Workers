# 跨平台 Workers 标准化契约

**结论**：H5 的核心 handler 已经是 WinterTC（ECMA TC55，前 WinterCG）形态的 `fetch(request, env) -> Response`，业务逻辑不依赖 Cloudflare 专有 API。平台差异只有 **2 个必需能力**（读配置、取静态资源）和 **1 个可选能力**（边缘缓存），已收敛到 `workers/src/platform.ts` 的 `PlatformAdapter`。接其它平台时核心代码零改动，只需实现一个适配器 + 一个薄入口 + 平台路由配置。

> 合规边界见 [README 顶部警示](../README.md) 与 [h5-channel.md](./h5-channel.md)：禁止在中国大陆下载、传播本软件及相关资源，禁止商业用途。多平台部署会放大暴露面，请勿据此把站点公开化。

## 统一层（已在仓库落地）

| 层 | 统一约定 | 位置 |
| --- | --- | --- |
| 入口 | `default.fetch(request, env)` | `workers/src/index.ts` |
| env 契约 | `Env` / `PlatformAdapter` | `workers/src/policy.ts`、`workers/src/platform.ts` |
| 配置名 | `H5_ACCESS_KEY`、`H5_ALLOWED_ORIGIN`、`H5_EXTRA_BASES` | `workers/src/platform.ts` 的 `createEnv()` |
| 产物 | 唯一一份 `dist/`，由 Worker Assets 托管，渠道靠运行时判断 | `h5:build` |
| 质量门禁 | `h5:ci` = Worker tsc + 契约校验 + 20 项冒烟 + 前端构建 | `package.json`、`.github/workflows/ci.yml` 的 `h5` job |
| 部署命令 | `h5:deploy` / `h5:preview`，内部固定 `wrangler@4` 与 `--config` | `package.json` |
| 安全策略 | 口令 + 同源 + 加密 Cookie + SSRF 校验 + CSP | Worker 内部，与平台无关 |

`h5:ci` 不部署、不需要任何凭据，任何云平台的接入流水线都可以先复用这一份门禁和同一份 `dist/`。

## 平台绑定点（只有三处）

| 绑定点 | 位置 | 为什么平台相关 | 收敛方式 |
| --- | --- | --- | --- |
| 运行时配置 | `policy.ts`、`rpc.ts`、`index.ts` 读 `env.H5_*` | CF 是 env 绑定，Deno 是 `Deno.env`，Node/Bun 是 `process.env` | `createEnv({ get })` |
| 静态资源 | `index.ts` 的 `env.ASSETS.fetch()` | 只有 CF Workers Assets 提供这个绑定，且解锁页/CSP 要求「所有请求先过函数」 | `createEnv({ fetchAsset })` |
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
| Cloudflare Workers | `export default { fetch }` | env 绑定 / `wrangler secret` | `ASSETS` + `run_worker_first = true` | `workers/wrangler.toml` | ✅ 已验证（`deploy --dry-run` + 20 项冒烟） |
| Deno Deploy | `Deno.serve()` | `Deno.env.get()` | 自行读 `dist/` 或外置对象存储 | 把 `/*` 指向函数 | 契约已备，未实机验证 |
| Vercel（Fluid Compute / Functions） | 平台 handler 导出 | `process.env` | 平台静态托管 + rewrites | 需 `/*` rewrite 到函数 | 契约已备，未实机验证 |
| Netlify Edge Functions | `export default` + `config` | `Deno.env` / 平台环境变量 | 平台静态托管 + redirects | 需 `/*` redirect 到函数 | 契约已备，未实机验证 |
| Node.js / Bun 自建 | `serve({ fetch })` / `Bun.serve()` | `process.env` | 从 `dist/` 读文件，需自己防目录穿越 | 反向代理指向进程 | 契约已备，未实机验证 |
| 国内云边缘函数（EdgeOne 类等） | 平台专有 handler | 平台环境变量 | 平台静态托管 / 对象存储 | 平台路由配置 | 契约已备，未实机验证；**需先确认 Web Crypto 是否支持 AES-GCM 与 AES-CBC** |

> 说明：Vercel 已把 Edge Functions 并入 Fluid Compute / Functions 体系，接入时以该平台当前的 handler 导出规范为准。

## 明确边界（不提供半成品）

- 本仓库**只提供 Cloudflare 的 `workers/wrangler.toml` 与完整部署链路**；不生成 `vercel.json`、`netlify.toml`、`deno.json` 等未经实机验证的平台配置——放进去却不能跑，比不放更糟。
- 要真正接入某个平台，最小改动是三件：实现 `get` 与 `fetchAsset`、写一个约 15 行的薄入口、配一条把所有路径指向函数的路由。**核心逻辑零改动**，`h5:ci` 可直接复用。
- 两个硬前提，缺一不可：
  1. **所有请求（含 HTML）必须先经过函数**。解锁页与 CSP 注入依赖这一点；若平台静态资源优先于函数，未解锁用户会直接拿到业务 JS。
  2. **运行时必须支持 Web Crypto 的 AES-GCM**（会话/线路 Cookie 加解密）**与 AES-CBC**（封面解密），以及流式 `Response` body 与 Range 透传。

## 风险标注

- **【高风险】合规 — 位置：多平台部署；影响：暴露面随平台数量放大，与 README 的大陆传播限制、非商业许可冲突；建议：仅个人自用，每个平台都强制访问口令与来源限制，不公开分享地址。**
- **【中风险】`fetchAsset` 实现 — 位置：非 CF 平台适配器；影响：若直接按请求路径读本地文件，可能造成目录穿越读到仓库其它文件；建议：只允许 `dist/` 内的规范化路径，禁止 `..`，未知路径回退 `index.html`。**
- **【中风险】缓存能力缺失 — 位置：`media.ts` 的 `withCache`；影响：无 Cache API 的平台每次 `img`/`seg` 都回源，上游压力与流量成本上升；建议：接平台时优先接它的边缘缓存或 CDN。**
- **【中风险】运行时行为差异 — 位置：多值 `Set-Cookie`、流式 body、Range/206；影响：播放器可能出现黑屏或登录态丢失；建议：每接一个平台都跑一遍 [h5-channel-deploy.md](./h5-channel-deploy.md) 步骤 6 的部署后验证判据。**
- **【中风险】契约漂移 — 位置：`scripts/test-h5-rpc-coverage.mjs`；影响：只校验命令名与常量，不校验参数形状；建议：上游 `api.rs` 变更后人工回归登录与互动流程。**

## 与 GitHub 链路的关系

```
GitHub 仓库（唯一源）
   ├─ .github/workflows/ci.yml → h5:ci        统一门禁，不部署、无凭据
   ├─ Cloudflare Workers Builds  → h5:deploy  CF 生产（截图那条路）
   └─ 其它云平台流水线          → 复用 dist/ + createEnv() 适配器
```

从 GitHub 拉取部署的完整步骤见 [h5-channel-deploy.md](./h5-channel-deploy.md) 文末的「方式 B」章节。

*平台能力与 WinterTC 基线核对于 2026-11-15，wrangler 4.162.0。*
