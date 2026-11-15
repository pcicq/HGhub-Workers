# H5 渠道（Cloudflare Workers）

**结论**：新增一条纯浏览器渠道，与上游 HGhubX 共用同一份前端源码与 `dist` 构建产物，由单个 Cloudflare Worker 同时托管静态资源和同源代理。前端在运行时判断是否处于 Tauri WebView，非 Tauri 时把 `invoke` 翻译成 `POST /hg/rpc`，媒体地址从 `hg://localhost` 换成同源 `/hg/*`。**本次只完成代码与配置，未执行任何部署/上线动作**，部署命令在下面，由你在本地执行。

> ⚠️ 先读 [README 顶部的大陆下载与传播限制警示](../README.md) 与首次启动协议第 1 条：禁止在中国大陆地区下载、复制、分享、传播本软件及相关资源，不得提供下载链接或传播服务；许可证为 PolyForm Noncommercial 1.0.0，禁止商业用途。H5 部署到公开域名（尤其无访问控制时）会直接与之冲突。下面的实现默认强制**访问口令 + 同源校验**，仅面向个人自用/小范围受控访问；如不符合上述条款，请勿部署。

## 请求链路

```
浏览器 → https://<你的域名>/                    静态资源（Workers Assets + CSP + 解锁页）
       → /hg/rpc        {cmd, args}          → Worker 命令表 → POST {上游}/api/edge/request（边缘信封）
       → /hg/img?u=                         封面（按需 AES-CBC 解密）
       → /hg/hls?u=                         m3u8，所有 URI 改写成 /hg/seg?u=
       → /hg/seg?u=                         分片 / 密钥 / 子清单，支持 Range
       → /hg/health                         能力探针（前端启动前校验 channel/api 标记）
```

上游地址、接口路径、token 都留在 Worker 侧；浏览器只接触同源 `/hg/*`。会话 token 存在 `HttpOnly` + `Secure` + `SameSite=Lax` 的加密 Cookie 里，前端不接触凭据。

## 文件清单

| 路径 | 作用 |
| --- | --- |
| `workers/wrangler.toml` | Worker + Assets 配置（`run_worker_first = true`，需 wrangler 4.x） |
| `workers/src/index.ts` | 路由、解锁页、CSP（内联脚本 hash）、同源校验 |
| `workers/src/policy.ts` | 口令签名、会话加解密、SSRF 防护、逐跳重定向校验 |
| `workers/src/rpc.ts` | 前端全部命令 → 上游边缘信封；账号身份绑定校验、线路探测与自动选线 |
| `workers/src/lines.ts` | 地址发布页解析（字面量数组词法器）、可信镜像集合、自动选线候选 |
| `workers/src/media.ts` | 封面解密、m3u8 改写、Range 透传、边缘缓存 |
| `workers/src/config.ts` | 常量；版本直接取根 `package.json` |
| `workers/src/platform.ts` | `PlatformAdapter` / `createEnv()`，把平台差异收敛为配置读取与静态资源获取 |
| `workers/tsconfig.json` | Worker 独立类型检查（不引入 CF 类型依赖） |
| `workers/.dev.vars.example` | 本地口令模板，复制为 `.dev.vars`（已忽略） |
| `src/transport.ts` | 前端传输层：Tauri 走原生 `invoke`，H5 走 `/hg/rpc` + 能力探针 |
| `scripts/test-h5-rpc-coverage.mjs` | 静态契约校验：命令覆盖与常量一致性，不通过则 `exit 1` |
| `scripts/test-h5-worker.mjs` | 运行时冒烟：探针 / 解锁 / 同源 / CSP / SSRF / 媒体缓存 / 线路，不联网，不通过则 `exit 1` |

前端改动点：`api.ts`（`LOCAL`、`call`、`logLine`）、`main.tsx`（探针与错误提示）、`App.tsx`（网页壳、平台命令降级）、`playbackDiagnostics.ts`、`Feed.tsx`、`UsageAgreement.tsx`、`LaunchAnimation.tsx`、`autoLine.ts`、`Settings.tsx`、`LinePicker.tsx`、`vite.config.ts`（本地 `/hg` 代理）。

## 本地验证

```sh
corepack pnpm install --frozen-lockfile     # 若本机已有 pnpm shim，把 corepack pnpm 换成 pnpm
corepack pnpm h5:build                     # 前端构建 + 静态契约校验
corepack pnpm h5:check                     # Worker 类型检查 + 静态契约校验 + Worker 冒烟测试
corepack pnpm test:h5-worker               # 单独跑运行时冒烟测试（无需 wrangler / 不联网）
cp workers/.dev.vars.example workers/.dev.vars
# 编辑 workers/.dev.vars，填入自己的 H5_ACCESS_KEY
corepack pnpm h5:dev                       # 打开 http://localhost:8787
```

`h5:dev` / `h5:deploy` 内部走 `npx --yes wrangler@4`，不会改动根 `package.json` / lockfile；脚本内部一律用 `npm run` / `node` / `npx`，因此在只有 `corepack pnpm`、没有 `pnpm` shim 的环境里也能跑。想用 `vite dev` 热更新时，另开一个终端跑 `corepack pnpm dev`，并在 `.dev.vars` 里加 `H5_ALLOWED_ORIGIN=http://localhost:1420`。

## 部署（由你本地执行）

手把手教程（账号准备、GitHub 拉取部署、secret 顺序、自定义域名、额度与排错）见 [h5-channel-deploy.md](./h5-channel-deploy.md)；跨平台标准化契约见 [h5-platforms.md](./h5-platforms.md)；本节是精简命令清单。

```sh
corepack pnpm h5:build
npx --yes wrangler@4 deploy --dry-run --config workers/wrangler.toml   # 本地预演配置，不上传
npx --yes wrangler@4 login
npx --yes wrangler@4 secret put H5_ACCESS_KEY --config workers/wrangler.toml   # 交互式输入，不要写进文件
corepack pnpm h5:deploy
```

可选变量（`wrangler.toml` 的 `[vars]` 或 `wrangler secret put`）：

| 变量 | 说明 |
| --- | --- |
| `H5_ACCESS_KEY` | **必填**，访问口令。轮换后所有已下发 Cookie 立即失效 |
| `H5_ALLOWED_ORIGIN` | 额外放行的 Origin，逗号分隔；仅用于本地 `vite dev` 联调 |
| `H5_EXTRA_BASES` | 额外可信上游 origin，逗号分隔，必须是 HTTPS 根地址 |

部署前确认 `dist/` 已由 `h5:build` 生成；Workers Assets 的 `directory = "../dist"` 是相对 `workers/wrangler.toml` 解析的。`--dry-run` 的判据：输出 `Read N files from the assets directory .../dist`、绑定表里出现 `env.ASSETS Assets`，并以 `--dry-run: exiting now.` 结束；若报找不到 `dist`，说明还没跑 `h5:build`。

## 部署后验证判据

| 检查 | 操作 | 期望 |
| --- | --- | --- |
| 能力探针 | `curl https://<域名>/hg/health` | `channel=h5`、`api=1`，`version` 等于根 `package.json` 的 version |
| 未解锁入口 | 浏览器打开 `/` | 只有解锁页，不加载业务 JS |
| 未解锁 RPC | `curl -X POST /hg/rpc -d '{"cmd":"app_boot"}'` | 401 |
| 跨站调用 | 已解锁后带外部 `Origin` 请求 `/hg/rpc` | 403（未解锁时先 401，属校验顺序） |
| 错误口令 | 提交表单 | 303 → `/?err=1` |
| 正确口令 | 提交表单 | 303 → `/`，`Set-Cookie: hg_access=...; HttpOnly; Secure; SameSite=Lax` |
| 静态资源 | 打开 `/` 后看响应头 | `Content-Security-Policy` 含 `script-src 'self' 'sha256-...'` |
| 列表与封面 | 首页加载 | `/hg/img?u=` 返回 200 + `image/*` |
| 播放 | 打开任一剧集 | `/hg/hls?u=` 返回 `#EXTM3U`，内部 URI 全是 `/hg/seg?u=`，分片 200/206 |
| 登录 | 登录一次后刷新 | `Set-Cookie: hg_session`，`/hg/rpc` 的 `app_boot` 返回 `logged_in: true` |
| SSRF 拦截 | `/hg/seg?u=http%3A%2F%2F127.0.0.1%2Fx` | 400，不发起上游请求 |
| 自定义线路 | 设置 → 网络 → 播放源 → 保存 HTTPS 根地址 | `line_state` 返回 `custom: true`，`hg_line` 为密文 Cookie，会话 Cookie 被清空 |
| 私网自定义线路 | 自定义线路填 `https://127.0.0.1/` | 400「线路地址无效」 |
| 镜像发布页 | 点开「线路」面板 | 「推荐镜像」「镜像线路」两组出现发布页地址，不再是空列表 |
| 自动选线 | 设置 → 网络打开「自动选择线路」 | `line_auto` 返回 `pick.reason` 为 `main-ok` / `mirror-ok` / `all-down`，不再是 `h5-fixed-line` |

其中「能力探针 / 未解锁入口与 RPC / 跨站调用 / 口令 / CSP / SSRF / 媒体缓存 / 线路全链路」已由 `test:h5-worker` 在本地无网络环境下覆盖（53 项断言）；需要真实上游的列表、封面、播放、登录与地址发布页仍须部署后人工回归。

## 能力边界（相对 Tauri 客户端）

| 功能 | H5 | 说明 |
| --- | --- | --- |
| 浏览 / 搜索 / 详情 / 播放 / 热搜 | 支持 | 热搜为官网 SSR 片段正则解析，结构变化会退化为空列表 |
| 登录 / 注册 / 评论 / 点赞 / 收藏 / 关注 / 观看历史 | 支持 | 复刻 v2.1.0 的 `expectedUserId` / `expectedOrigin` 身份绑定 |
| 固定线路 / 自定义线路 | 支持 | `line_set` 只放行固定线路、`H5_EXTRA_BASES` 与可信发布页镜像；`line_custom_set` 需用户显式保存纯 HTTPS origin，写入加密 `hg_line` Cookie |
| 镜像发布页 / 推荐镜像 / 镜像线路 | 支持 | 复用 `src-tauri/src/lines.rs` 的发布页模型：同源 `publish.js`、顶层字面量数组解析、交错去重、当前线路置顶；远端 JS 从不执行 |
| 线路探测 / 自动选线 / 回切主站 / 线路体检 | 支持 | 用 `/api/videos` 真实数据判活；`line_probe` 单次最多 24 条、`line_auto` 最多 10 个候选（边缘子请求预算，桌面端分别是 60 / 10） |
| 应用内代理 / 检查更新 | 不支持 | 浏览器无应用级代理与安装包，出口由边缘运行时决定 |
| 严格安全模式 | 固定开启 | 服务端强制，不提供关闭入口 |
| 网络诊断 / 播放诊断日志落盘 / 清理缓存 | 降级为空操作 | 浏览器无应用数据目录；缓存由 TTL 控制 |
| 桌面标题栏 / 窗口缩放 / 屏幕方向 / 退出应用 | 不适用 | 使用无壳网页布局 |

## 媒体链路：与桌面端 `media.rs` 的对照

上游仓库的「不卡」建立在**三级缓存 + 连接复用 + 有限重试**上（`src-tauri/src/media.rs`、`net.rs`、`media_dns.rs`）。H5 是无状态 Worker，无法照搬进程内缓存，按等价效果实现：

| 环节 | 桌面端 Rust | H5 Worker | 等价性 |
| --- | --- | --- | --- |
| 主清单 `/hls` | `PL_CACHE` 60 条进程内存缓存，HTTP 头 `no-store` | 每次回源，`no-store`，无内存缓存 | ❌ 起播多一次回源；不解释持续卡顿 |
| 子清单 `/seg` | 识别后继续改写 URI，`public, max-age=3600`（`media-cache-audit-20261108.md` 明确要求保留） | 同 | ✅ |
| 分片 / Key | `fetch_bytes().bytes().await` 收完整 → `SEG_CACHE`（≤4 MB / 36 条）、`KEY_CACHE`（≤64 KB / 120 条）→ `apply_byte_range` 本地切片，**Range 从不转发上游** | 流式直透、Range 转发上游，浏览器按 `public, max-age=3600` 本地缓存 | ⚠️ 效果接近、实现不同 |
| 出站超时 | `get_with_dns` 整个逐跳链路共用 20s，connect 10s | `fetchGuarded` 默认 20s；发布页 8s / 线路探测 5s 用自带 signal | ✅ |
| 重试 | `with_retry(true)` 最多 3 次 + 350/700ms 退避 + `heal_client` 重建客户端；只重试 408/425/429/5xx 与网络错误 | 服务端不重试，由 hls.js `fragLoadingMaxRetry: 6` 承担 | ⚠️ 偶发抖动多付一次 RTT |
| 连接 / DNS | reqwest Client 复用 30s、`pool_idle_timeout 60s`、`gzip/brotli`；DNS 失败切阿里公共 DNS（`media_dns.rs`） | CF 边缘连接池与 DNS | ❌ 平台决定，不可搬 |
| 播放器 | hls.js `maxBufferLength 30` / `fragLoadingTimeOut 25000` / 6 次重试 / 非致命 stall 立即 `startLoad()` | 同一套前端代码，参数完全相同 | ✅ |

🔴 **流式分片绝不进 Cache API**。此前把 `waitUntil(cache.put(request, fresh.clone()))` 用在 `/seg` 上：`Response.clone()` 会 tee 上游流，`cache.put` 若因 206 / Vary / 响应头不符提前失败，第二个分支不会被消费完，tee 的背压会反过来卡住返回给播放器的分支——这正是「改了缓存还是卡」的原因。桌面端从没有这条路径：它先收完整字节再返回，从不 clone 在途流。现在 `/seg` 纯流式直透，重复分片交给浏览器 HTTP 缓存；`withCache` 只服务已完整缓冲在内存的 `/img`。

**改代码消除不了的部分**：浏览器 → CF 边缘 → Worker → 上游 CDN 比桌面端多一跳；上游 CDN 在国内、边缘节点在境外时 RTT 由线路决定。要降它只能换线路 / 换部署区域 / 让分片直连上游 CDN，但后者会破坏同源口令与 SSRF 边界，不做。

**需要实机确认的上游形态**（本次只做仓库内源码核对，未访问上游站点、未抓真实 m3u8）：DevTools → Network 过滤 `/hg/seg`，看 ① TTFB 与总耗时；② 是否 206、带不带 `Content-Range`；③ 有没有 302 逐跳；④ 单分片大小。TTFB 高、传输短 → 跨境 RTT 或上游响应慢；TTFB 低但总耗时长且分片 >1 MB → 带宽；大量 206 → 走的是 iOS/Safari 原生 HLS，Range 每次回源，需让浏览器走 hls.js。

## 风险

- **【高风险】合规**：见顶部警示。公开、无口令、商业或面向中国大陆提供传播服务都超出本仓库允许范围。若无法确保，请不要部署，或改用本机 `wrangler dev` 自用。
- **【高风险】上游压力与费用**：所有 API、封面、m3u8、分片都经 Worker 转发，产生 Workers 请求数与带宽成本，也受运行时 CPU/内存/子请求限制。README「不要给上游增加压力」「不要改小或关掉缓存」在这里同样适用；`/img` 走边缘 Cache API，`/seg` 给浏览器 `public, max-age=3600` 由浏览器复用（流式分片不进 Cache API，原因见上一节），`/hls` 保持 `no-store`（与 Tauri 侧一致）。
- **【中风险】共享口令**：`H5_ACCESS_KEY` 是单口令，不是按用户身份鉴权；任何拿到口令的人都能访问。Cookie 有效期 30 天，轮换密钥即可全部失效。公开部署建议叠加 Cloudflare Access / WAF 来源 IP 限制。
- **【中风险】媒体目标只拦私网**：`/hg/seg` 允许任意公网 HTTP(S) 目标（已拦本机、内网、保留地址、内部协议主机名，且逐跳校验重定向）。若站点可公开访问，可能被当作通用代理，建议加来源限制。
- **【中风险】自定义线路即凭据去向**：保存自定义线路后，登录 token 会随 `/hg/rpc` 发往该 origin；会话按 origin 隔离、切换线路即清空，但用户仍需自行确认站点可信。线路必须是纯 HTTPS origin，`parseTarget` 已拦本机/内网/保留地址、认证信息与跨跳重定向；**Worker 无法像桌面端那样先做 DNS 解析再判 IP**，域名被解析到私网地址的 DNS rebinding 场景在边缘侧无法完全排除。只保存自己信任的站点，并叠加来源 IP 限制。
- **【中风险】线路探测的子请求预算**：`line_mirrors` 一次最多 4 个子请求，`line_probe` 最多 24 个、`line_auto` 最多 11 个（主站 1 + 候选 10）。免费额度下单次请求的 50 子请求上限仍够用，但不要把这些上限调高；发布页 8 秒、探测 5 秒各有独立超时。
- **【中风险】契约漂移**：`test:h5-coverage` 只校验命令名与常量，不校验参数形状。上游再改 `api.rs` 后需人工回归登录与互动流程。
- **【中风险】本地 Cookie**：`Secure` Cookie 在 `http://localhost` 下依赖浏览器对 localhost 的安全上下文例外；若解锁后反复跳回解锁页，直接用 `wrangler dev` 的 8787 端口访问，不要经其它主机名。

## 排错

| 现象 | 常见原因 |
| --- | --- |
| 顶部出现「H5 渠道不可用」 | `/hg/health` 不通或版本标记不匹配；检查 Worker 是否部署、`H5_ACCESS_KEY` 是否配置 |
| 所有 RPC 401 | 未解锁、密钥轮换后 Cookie 失效，或 Cookie 被浏览器拒绝 |
| RPC 403 | Origin 不是同源；本地 `vite dev` 需配 `H5_ALLOWED_ORIGIN` |
| 封面 502「封面解密失败」 | 上游更换了封面 AES key/IV，需同步 `media.ts` 与 Rust 侧 `media.rs` |
| 播放黑屏 | 看 `/hg/hls` 是否为 m3u8、URI 是否全部改写到 `/hg/seg`；再看分片是否 200/206 |
| 登录后刷新掉登录 | `hg_session` Cookie 被拦截（无痕模式/第三方 Cookie 策略） |
