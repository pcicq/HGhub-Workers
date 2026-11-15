> ### ⚠️ 中国大陆下载与传播限制
>
> **禁止在中国大陆地区下载、复制、分享、传播本软件及通过本软件获取的相关资源；不得提供相关下载链接或传播服务。**
>
> 本条亦适用于相关安装包、更新包、镜像与转发。若不符合本条要求，请停止获取、传播本应用并退出。

<div align="center">

<img src="public/logo.svg" alt="HGhub-Workers" width="128" height="128" />

# HGhub-Workers

**HGhubX 的 H5 / Workers 渠道 · 最小可构建闭包**

React + Vite 前端 + WinterTC 形态的边缘 Worker，同源代理 RPC 与媒体资源

</div>

> ⚠️ 免责声明：本项目仅供 **学习与技术交流**，不提供、不存储、不分发任何音视频内容，与任何内容提供方无关联。
> 所有内容均来自第三方站点，版权归原作者与上游站点所有；使用者应自行遵守所在地法律法规，因使用产生的任何后果由使用者自行承担。

> 本仓库是 [zxsos/HGhubX](https://github.com/zxsos/HGhubX) 的派生分支，只保留能构建并部署 H5 渠道的最小文件集合，**不包含** Tauri / Rust 桌面与移动端工程。上游客户端的完整说明以原仓库为准。

## 仓库定位

| 项 | 说明 |
| --- | --- |
| 产物 | 唯一一份 `dist/`，由 Worker 的 Assets 托管，也是 H5 的运行产物 |
| 入口 | `workers/src/index.ts` 的 `default.fetch(request, env)` |
| 传输 | 浏览器 `POST /hg/rpc` → Worker 命令表 → 上游边缘信封；媒体走 `/hg/img`、`/hg/hls`、`/hg/seg` |
| 访问控制 | 访问口令（`H5_ACCESS_KEY`，用 `wrangler secret` 写入）+ 同源校验 + HttpOnly 加密 Cookie |
| 标准化 | 平台差异收敛到 `workers/src/platform.ts` 的 `PlatformAdapter` / `createEnv()` |
| 门禁 | `h5:ci` = Worker tsc + 契约校验 + 53 项冒烟 + 前端构建；CI 不含任何部署动作 |

核心 handler 不依赖 Cloudflare 专有 API。接其它 WinterTC 运行时只需实现 `get()` 与 `fetchAsset()`、写一个薄入口、把全部路径路由到函数，详见 [docs/h5-platforms.md](docs/h5-platforms.md)。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `workers/` | Worker 源码、`wrangler.toml`、本地口令模板 |
| `src/` | 前端源码（与上游共用，运行时按 `window.__TAURI_INTERNALS__` 判断渠道） |
| `index.html`、`vite.config.ts`、`tsconfig.json` | 前端构建所需 |
| `scripts/test-h5-*.mjs` | H5 契约校验与 Worker 冒烟测试 |
| `src-tauri/src/net.rs`、`lines.rs` | 仅作固定线路契约校验的对照源，不参与构建 |
| `docs/` | 技术说明、Cloudflare 部署教程、跨平台标准化契约 |
| `.github/workflows/ci.yml` | 唯一的 H5 质量门禁 |

> `src-tauri/` 只保留两个 Rust 源文件供 `test-h5-coverage` 校验固定线路，**没有** `Cargo.toml`；本仓库不做 Rust 编译，也不打包桌面端。

## 快速开始

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm h5:ci            # 契约校验 + 冒烟 + 构建 dist/
cp workers/.dev.vars.example workers/.dev.vars   # 填入自己的 H5_ACCESS_KEY
corepack pnpm h5:dev           # http://localhost:8787
```

脚本内部一律用 `npm run` / `node` / `npx`，因此只有 `corepack pnpm`、没有 `pnpm` shim 的环境也能跑。部署见下节；完整命令与排错见 [docs/h5-channel-deploy.md](docs/h5-channel-deploy.md)，平台差异见 [docs/h5-platforms.md](docs/h5-platforms.md)，能力边界与风险见 [docs/h5-channel.md](docs/h5-channel.md)。

## 部署方式

两条链路共用同一份业务代码与 `h5:ci` 门禁，差别只在构建产物与入口。**命令由你在本地/控制台执行**，仓库不代为部署；口令一律写入平台 Secret（变量），不进仓库、不进 `[vars]`。

| 链路 | 构建 | 部署 | 产物 |
| --- | --- | --- | --- |
| Cloudflare Workers | `h5:build` | `h5:deploy`，或 Workers Builds Git 集成 | `dist/` + `workers/wrangler.toml` |
| 阿里云 ESA 函数和 Pages | `h5:pages:build` | 控制台 Git 集成（无脚本） | `esa-static/` + `pages-dist/esa-worker.js` |

> 另有 Cloudflare Pages（advanced mode）兼容链路，产物同为 `pages-dist/_worker.js`，命令见 [docs/h5-platforms.md](docs/h5-platforms.md)。

### Cloudflare Workers

```sh
corepack pnpm h5:build                                     # 生成 dist/
npx --yes wrangler@4 login && npx --yes wrangler@4 whoami    # 登录并确认账号
npx --yes wrangler@4 deploy --dry-run --config workers/wrangler.toml   # 预演，不上传
corepack pnpm h5:deploy                                    # 首次部署，记下 *.workers.dev 地址
npx --yes wrangler@4 secret put H5_ACCESS_KEY --config workers/wrangler.toml   # 交互输入口令
```

- **顺序不能反**：`secret put` 会再部署一个版本，必须在 Worker 创建之后执行。
- **Git 集成（Workers Builds）**：Build `npm run h5:build`、Deploy `npm run h5:deploy`、Preview `npm run h5:preview`；分支填 `master`（不是 `main`），项目名填 `hghub-workers-h5`，口令加到 `Settings → Variables & Secrets`（Secret 类型，不是 Build Variables）。
- 认准 **Workers 项目**（`*.workers.dev`），不是 Pages（`*.pages.dev`）。

### 阿里云 ESA 函数和 Pages

控制台 Git 集成部署，表单按此填写：

| 字段 | 值 |
| --- | --- |
| 生产分支 / 根目录 | `master` / `/` |
| 构建命令 | `npm run h5:pages:build`（**不是** `h5:build`） |
| 静态资源目录 | `./esa-static`（**不能**填 `./dist`，否则 `index.html` 绕过解锁页） |
| 函数文件路径 | `./pages-dist/esa-worker.js` |
| Node.js 版本 | `22.x` |
| 函数变量 | `H5_ACCESS_KEY`（勾选加密存储），可选 `H5_ALLOWED_ORIGIN`、`H5_EXTRA_BASES` |

- 不要配 `assets.notFoundStrategy`，否则 `/` 不落到函数，解锁页失效。
- 函数变量改动后需**重新生成版本并发布**才生效。
- 单次执行最多 4 个 `fetch`：浏览 / 搜索 / 播放正常，`line_probe`、`line_auto`、`line_mirrors` 必然超限（属降级，非缺陷）。

### 部署后验证（两条链路通用）

| 检查 | 期望 |
| --- | --- |
| `curl -sS $H5_URL/hg/health` | 200，`channel` 为 `h5`；未配口令时 503 属预期 |
| 未解锁访问 `/` | 只有口令解锁页，不加载业务 JS（ESA 若返回 404 或业务页 = 该链路不可用） |
| 输入口令 | 303 回 `/`，返回业务页且响应头带 `Content-Security-Policy` |
| `/assets/*`、`/logo.svg` | 200 |

逐项判据见 [docs/h5-channel-deploy.md](docs/h5-channel-deploy.md) 步骤 6。

## H5 渠道（实验性）

单个 Worker 同时托管同一份前端产物与同源代理，接口与登录凭据只留在服务端，不对公开访客开放。默认强制**访问口令 + 同源校验**。线路能力与桌面端对齐：固定线路、自定义线路、地址发布页镜像、手动探测、自动选线与回切主站都可用，当前线路存在加密 Cookie 中。

> H5 渠道同样受本文顶部「中国大陆下载与传播限制」与使用须知的约束：**不要公开部署、不要传播接口或直链、不要商业化**。若不符合条款，请勿部署，仅在本地 `wrangler dev` 自用。

**使用须知**

- **以访客身份正常使用**：像普通访客一样浏览就好，请勿滥用本项目。
- **不要给上游增加压力**：本项目本身不提供下载功能，请勿改动代码去做批量下载 / 批量抓取，也不要高频轮询、并发轰炸接口或挂机刷播放量；内置的封面与播放列表缓存请不要改小或关掉。
- **尊重上游版权**：不要去除水印与站点标识，不要把剧集搬运、转码、修改后二次分发到别处（网盘、资源站、其他 App 等），更不能改完拿出去出售。
- **不要公开传播接口与直链**：接口地址、播放直链、解密方式请勿公开张贴或打包成「资源站」——上游一旦封禁，所有人都没法再用。
- **不要商业化**：禁止打包出售、接入广告 / 会员 / 付费点播，或作为收费服务的一部分分发（详见 [LICENSE](LICENSE)）。
- **合理使用**：仅供个人学习、研究与自用；请在 24 小时内删除相关资源，并支持正版。
- **遵守当地法律**：使用者应自行判断并承担合规责任。

## 上游兼容说明

- 前端沿用上游 `hghubx_*` 本地存储键与界面文案，避免破坏上游的数据迁移逻辑；本仓库改名只作用于仓库与 Worker 层标识。
- 新增 `invoke` 命令必须同步 `workers/src/rpc.ts` 的命令表或 `src/transport.ts` 的 `LOCAL_COMMANDS`；协议版本 `API_CONTRACT`、媒体前缀 `/hg`、固定线路在前端与 Worker 各有一份定义，由 `test-h5-rpc-coverage.mjs` 校验一致。
- 契约脚本只校验命令名与常量，不校验参数形状。上游再改 `api.rs` 后需人工回归登录与互动流程。

## 免责声明

- 本项目与内容提供方无任何关联，作者不参与内容的制作、上传与分发。
- 使用者应自行遵守所在地法律法规；因使用本项目产生的任何后果由使用者自行承担。
- 若相关权利方认为本项目存在侵权，请通过 Issue 联系，我们会及时处理。

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) —— **仅限非商业用途**。

- **允许**：个人学习、研究、自用、爱好项目，以及在非营利组织内部使用；可以自由修改、二次开发。
- **禁止**：任何商业用途。包括但不限于打包出售、接入付费/会员/广告变现、作为收费服务或商业产品的一部分分发。
- **保留声明**：分发本项目或其修改版时，必须附带本许可证全文（或上面的链接）以及 `Required Notice` 声明行。
