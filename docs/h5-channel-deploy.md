# 部署到 Cloudflare Workers（H5 渠道手把手教程）

**结论**：本仓库已写好 Worker 与 `wrangler.toml`，部署主流程是「构建 → 登录 → 预演 → 首次部署 → 写入口令 → 验证」。**所有命令由你在本地执行，本会话不代为部署/上线**；本教程只提供命令与验证判据。技术说明、能力边界与风险表见 [h5-channel.md](./h5-channel.md)。

> ⚠️ 先读 [README 顶部的大陆下载与传播限制警示](../README.md)：禁止在中国大陆地区下载、复制、分享、传播本软件及相关资源，不得提供下载链接或传播服务；许可证为 PolyForm Noncommercial 1.0.0，禁止商业用途。把 H5 部署到公开域名（尤其无访问控制、可自由传播时）会直接与之冲突。**若无法确保合规，请只做本机 `wrangler dev` 自用，不要部署。**

本文提供两种部署方式：

| 方式 | 入口 | 适用 |
| --- | --- | --- |
| A. 本地 CLI（步骤 0–8） | 本机 `wrangler deploy` | 首次验证、个人自用 |
| B. GitHub 拉取（文末「方式 B」） | Cloudflare Workers Builds Git 集成，push 到生产分支即部署；**本仓库生产分支是 `master` 而不是 `main`** | 团队协作、不想在本机配凭据 |

跨平台标准化契约见 [h5-platforms.md](./h5-platforms.md)。

## 步骤总览

| 步骤 | 做什么 | 完成判据 |
| --- | --- | --- |
| 0 | 确认前置条件 | Node 可用、有 Cloudflare 账号、终端能访问 Cloudflare |
| 1 | 安装依赖并构建 | `h5:check` 三项全绿，`dist/` 有 `index.html` |
| 2 | 登录 Cloudflare | `whoami` 打印账号邮箱 |
| 3 | 本地预演配置 | 输出 `--dry-run: exiting now.`，**未上传** |
| 4 | 首次部署 | Wrangler 打印 `https://hghub-workers-h5.<子域>.workers.dev` |
| 5 | 写入访问口令 | `secret put` 成功且会**自动再部署一个版本** |
| 6 | 验证 | `/hg/health` 返回 `channel=h5`，解锁后可浏览播放 |
| 7 | 绑定自定义域名（可选） | 证书生效、域名可访问 |
| 8 | 日常更新 / 轮换口令 | 见文末 |

---

## 0. 前置条件

| 项 | 要求 | 检查 |
| --- | --- | --- |
| Node.js | 建议 20+；本项目实测 22.22.2，`npx --yes wrangler@4 --version` 能跑通即满足 | `node --version` |
| 包管理器 | 本机若无 `pnpm` shim，用 `corepack pnpm` | `corepack pnpm --version` |
| Cloudflare 账号 | 免费版即可；建议开启双因素认证 | 在 [dash.cloudflare.com](https://dash.cloudflare.com) 注册 |
| 自定义域名（可选） | 域名已接入 Cloudflare 且 zone 为 active | 仅步骤 7 需要 |
| 网络 | 终端能访问 `dash.cloudflare.com` / `api.cloudflare.com` | — |

Wrangler **不需要全局安装**，通过 `npx --yes wrangler@4` 临时调用，不改动根 `package.json` / `pnpm-lock.yaml`。当前实测版本 `4.162.0`；若需可复现，把 `wrangler@4` 固定成 `wrangler@4.162.0`。

---

## 1. 安装依赖、构建并本地自检

在项目根目录执行：

```sh
corepack pnpm install --frozen-lockfile     # 本机有 pnpm shim 就直接用 pnpm
corepack pnpm h5:check                      # Worker tsc + 静态契约校验 + 运行时冒烟测试
corepack pnpm h5:build                      # 前端构建，生成 dist/
```

判据：`h5:check` 输出 `H5 契约校验通过` 与 `H5 Worker 冒烟测试通过`；`h5:build` 末尾出现 `✓ built in ...` 与契约校验通过。`dist/index.html` 必须存在——Workers Assets 的 `directory = "../dist"` 是相对 `workers/wrangler.toml` 解析的。

**先在本地 `wrangler dev` 跑一遍更稳妥**（不消耗线上额度、不对外暴露）：

```sh
cp workers/.dev.vars.example workers/.dev.vars
# 编辑 workers/.dev.vars，填入自己的 H5_ACCESS_KEY；该文件已被 .gitignore 忽略
corepack pnpm h5:dev                        # 打开 http://localhost:8787
```

---

## 2. 登录 Cloudflare

```sh
npx --yes wrangler@4 login
npx --yes wrangler@4 whoami
```

`login` 走 OAuth，会自动打开浏览器（`localhost:8976` 回调）。`whoami` 应打印账号邮箱，否则后续命令会失败。

| 场景 | 命令 |
| --- | --- |
| 远程 SSH / 容器 / 浏览器打不开回调 | `npx --yes wrangler@4 login --device`（设备码授权，不开本地回调服务器） |
| 只想拿到链接自己粘贴 | `npx --yes wrangler@4 login --browser=false` |
| CI / 无浏览器 | 用 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 环境变量，[参考官方 CI 文档](https://developers.cloudflare.com/workers/ci-cd/) |
| 凭据想存系统钥匙串 | `npx --yes wrangler@4 login --use-keyring` |

> 凭据默认落在用户目录的 `~/.config/.wrangler/`，不在仓库内；不要把它提交或外传。

---

## 3. 本地预演（不上传）

```sh
npx --yes wrangler@4 deploy --dry-run --config workers/wrangler.toml
```

判据：输出 `Read N files from the assets directory .../dist`、绑定表里出现 `env.ASSETS Assets`，并以 `--dry-run: exiting now.` 结束。2026-11-15 在本仓库实测读取 16 个 assets 文件、`Total Upload: 50.68 KiB / gzip: 14.82 KiB`（体积随构建内容变化，以本机输出为准）。若报找不到 `dist`，回到步骤 1 先 `h5:build`。

`--dry-run` 的官方语义是「Compile a project without actually deploying to live servers」，不会创建 Worker、不会产生费用。

---

## 4. 首次部署

```sh
corepack pnpm h5:deploy
```

等价于 `npx --yes wrangler@4 deploy --config workers/wrangler.toml`。首次执行会按 `wrangler.toml` 的 `name = "hghub-workers-h5"` 创建 Worker，Wrangler 会打印访问 URL，形如：

```
https://hghub-workers-h5.<你的子域>.workers.dev
```

因为配置里没有 `route` / `routes`，官方默认 `workers_dev = true`，会自动分配该子域。把这个地址记下来：

```sh
export H5_URL="https://hghub-workers-h5.<你的子域>.workers.dev"
curl -sS "${H5_URL}/hg/health"
```

**此时预期返回 503**（`H5_ACCESS_KEY 未配置`）——这是刻意设计的安全失败：探针直接失败，前端不会误以为网关可用，站点也不会对外开放业务内容。不要在配好口令前把地址发出去。

---

## 5. 写入访问口令（必填）

口令只在终端交互式输入，**不要写进命令、脚本、文件或 shell history**：

```sh
npx --yes wrangler@4 secret put H5_ACCESS_KEY --config workers/wrangler.toml
```

出现 `Enter a secret value:` 后粘贴你自己的长口令并回车。判据：命令成功，且 `/hg/health` 变成 200：

```sh
curl -sS "${H5_URL}/hg/health"
# 形如 {"channel":"h5","api":1,"version":"<package.json 的 version>","auth":"cookie"}
```

> **重要**：官方明确 `wrangler secret put <KEY>` 会**创建 Worker 的一个新版本并立即部署**，等于步骤 4 之后再上线一次。因此按「先 `h5:deploy` 创建 Worker，再 `secret put`」的顺序执行最稳妥；若 `secret put` 提示找不到 Worker，先补跑一次 `h5:deploy`。全局 `--config` 对该命令同样有效（已用 `wrangler secret --help` 核对）。
>
> 官方文档另有 `wrangler deploy --secrets-file <file>` 可在首次部署时一并上传 secret，但会在磁盘留下明文文件，与本仓库「真实凭据不落盘、不提交」的约定冲突，**不推荐**。
>
> 可选加固：在 `workers/wrangler.toml` 声明必需密钥，让漏配时 `wrangler deploy` 直接报错。官方给的是 JSON/JSONC 示例 `{ "secrets": { "required": ["API_KEY"] } }`，等价 TOML 写法为：
>
> ```toml
> [secrets]
> required = ["H5_ACCESS_KEY"]
> ```
>
> 两个副作用要注意：① 加上后首次 `deploy` 会因远程还没有 secret 而失败，应**在首次部署成功、secret 已写入之后再加**；② 官方说明「定义 `secrets.required` 后，只有列出的键会从 `.dev.vars` / `.env` 加载」，所以本地联调若还用得到 `H5_ALLOWED_ORIGIN` 等变量，得一并列入，或改写到 `[vars]`。

其它可选变量（`H5_ALLOWED_ORIGIN`、`H5_EXTRA_BASES`）不是密钥，可写进 `workers/wrangler.toml` 的 `[vars]` 或部署时用 `--var` 注入；含义见 [h5-channel.md](./h5-channel.md)。启用上面的 `[secrets]` 声明后，建议先跑一次步骤 3 的 `--dry-run` 确认配置被当前 wrangler 版本接受。

---

## 6. 部署后验证

沿用步骤 4 的 `${H5_URL}`（若新开了终端，重新 `export H5_URL="..."`）。口令只在浏览器解锁页输入，不要写进 curl 命令。

| 检查 | 操作 | 期望 |
| --- | --- | --- |
| 能力探针 | `curl -sS "${H5_URL}/hg/health"` | `channel=h5`、`api=1`、`version` 等于根 `package.json` 的 `version` |
| 未解锁入口 | 浏览器打开 `/` | 只有解锁页，不加载业务 JS |
| 未解锁 RPC | `curl -sS -i -X POST "${H5_URL}/hg/rpc" -H 'Content-Type: application/json' -d '{"cmd":"line_mirrors"}'` | 401 |
| 正确口令 | 解锁页输入口令提交 | 跳到 `/`，DevTools 可见 `Set-Cookie: hg_access=...; HttpOnly; Secure; SameSite=Lax` |
| 错误口令 | 随便输一个 | 跳回 `/?err=1` |
| 跨站调用 | 已解锁后，带外部 `Origin: https://evil.example` 与 `hg_access` Cookie 请求 `/hg/rpc` | 403；**未解锁时先返回 401**，这是校验顺序所致，不是异常 |
| CSP | DevTools Network 看 `/` 响应头 | `Content-Security-Policy` 含 `script-src 'self' 'sha256-...'` |
| 列表与封面 | 首页加载 | `/hg/img?u=` 返回 200 + `image/*` |
| 播放 | 打开任一剧集 | `/hg/hls?u=` 返回 `#EXTM3U`，内部 URI 全是 `/hg/seg?u=`，分片 200/206 |
| 登录 | 登录一次后刷新 | `Set-Cookie: hg_session`，`/hg/rpc` 的 `app_boot` 返回 `logged_in: true` |
| SSRF 拦截 | 浏览器解锁后打开 `${H5_URL}/hg/seg?u=http%3A%2F%2F127.0.0.1%2Fx` | 400「禁止访问普通内网、回环或保留地址」 |

其中「探针 / 未解锁入口与 RPC / 跨站 / 口令 / CSP / SSRF」已由 `test:h5-worker` 在本地无网络环境覆盖；**需要真实上游的列表、封面、播放、登录只能部署后人工回归**。

---

## 7. 绑定自定义域名（可选）

前提：域名已接入 Cloudflare 且 zone 为 active；目标 hostname 上没有已存在的 CNAME 记录。

**方式 A — Dashboard**（推荐，不动配置文件）：`Workers & Pages` → 选中 `hghub-workers-h5` → `Settings` → `Domains & Routes` → `Add` → `Custom Domain` → 填域名 → `Add Custom Domain`。Cloudflare 会自动建 DNS 记录并签发证书，等待几分钟生效。

**方式 B — wrangler.toml**：

```toml
[[routes]]
pattern = "h5.example.com"
custom_domain = true
```

然后重新 `corepack pnpm h5:deploy`。

> **易踩的坑**：官方规则是「配置里出现 `route` / `routes` 时，`workers_dev` 默认为 `false`」。加了自定义域名后，步骤 4 的 `*.workers.dev` 地址可能不再可用；想两个都保留，在 `wrangler.toml` 顶层显式加 `workers_dev = true` 再部署。

绑完把 `${H5_URL}` 换成新域名，重跑步骤 6。`Secure` Cookie 在 HTTPS 自定义域名下正常工作；本地 `http://localhost:8787` 依赖浏览器对 localhost 的安全上下文例外，若解锁后反复跳回解锁页，换回 HTTPS 域名验证。

---

## 8. 日常维护

| 动作 | 命令 | 说明 |
| --- | --- | --- |
| 改了前端或 Worker 代码 | `corepack pnpm h5:check && corepack pnpm h5:build && corepack pnpm h5:deploy` | 每次 deploy 上传新版本 |
| 只轮换访问口令 | `npx --yes wrangler@4 secret put H5_ACCESS_KEY --config workers/wrangler.toml` | 所有已下发 Cookie 立即失效；**会再部署一个版本** |
| 只改可选变量 | 改 `[vars]` 后 `corepack pnpm h5:deploy` | 不要往 `[vars]` 写口令 |
| 查看线上日志 | `npx --yes wrangler@4 tail --config workers/wrangler.toml` | 排查 502 / 播放失败 |
| 查看当前 secret 名 | `npx --yes wrangler@4 secret list --config workers/wrangler.toml` | 只列名字，值不可见 |
| 下线 | Dashboard → Worker → `Delete`，或 `npx --yes wrangler@4 delete --config workers/wrangler.toml` | **【高风险】破坏性操作，不可撤销**，执行前确认没有别的服务依赖它 |

---

## 额度与费用

Workers Free 计划（[官方 Limits](https://developers.cloudflare.com/workers/platform/limits/) / [Pricing](https://developers.cloudflare.com/workers/platform/pricing)）：

| 项 | 免费版 |
| --- | --- |
| 请求数 | 100,000 / 天 |
| CPU 时间 | 10 ms / 请求（等待网络不计入） |
| 子请求 | 50 / 请求 |
| 内存 | 128 MB |
| 静态资源 | 官方标注「静态资源请求免费且不限量」，单文件 ≤ 25 MiB、每版本 ≤ 20,000 个文件 |
| 付费计划 | $5/月起，含 1000 万请求/月 + 3000 万 CPU ms，超出 $0.30/百万请求、$0.02/百万 CPU ms |

**但本仓库的 `run_worker_first = true` 会让每一个请求（包括 JS/CSS/图片）都先执行 Worker**，用于注入 CSP 和做访问控制；此时静态资源是否仍按「免费且不限量」计费，官方定价页没有针对该配置给出明确口径。另外官方注明「启用 Workers Caching 时，缓存命中的请求仍按调用 Worker 的请求费率计费」——我们给 `img`/`seg` 做的边缘缓存不能当成免费用量。**以 Dashboard 账单和 Workers 指标为准，部署后前几天盯一下请求数。**

---

## 风险标注

- **【高风险】合规 — 位置：整个公开部署行为；影响：违反 README 的大陆下载传播限制与非商业许可；建议：无法确保合规时不要部署，只跑本地 `wrangler dev`，并叠加 Cloudflare Access / WAF 来源限制。**
- **【高风险】破坏性操作 — 位置：`wrangler delete` / Dashboard 删除 Worker；影响：服务与配置不可恢复；建议：仅在你明确要下线时执行，先备份 `wrangler.toml` 与口令。**
- **【中风险】共享口令 — 位置：`H5_ACCESS_KEY`；影响：单口令无按用户鉴权，拿到口令即可访问，Cookie 有效期 30 天；建议：用长随机口令、定期轮换，公开访问叠加 Access。**
- **【中风险】计费口径不确定 — 位置：`run_worker_first = true` + Cache API；影响：免费额度消耗可能快于预期；建议：部署后在 Dashboard 监控请求数与 CPU，必要时升级付费计划。**
- **【中风险】上游压力与成本 — 位置：`/hg/{rpc,img,hls,seg}`；影响：所有 API/封面/分片都经 Worker 转发，会消耗子请求与带宽，也可能给上游加压；建议：保持 `img`/`seg` 边缘缓存，不要关闭。**
- **【中风险】媒体代理被滥用 — 位置：`/hg/seg` 允许任意公网 HTTP(S) 目标；影响：站点公开时可能被当通用代理；建议：限制访问来源，不公开分享地址。**
- **【中风险】凭据落盘 — 位置：`--secrets-file` / `.dev.vars` / shell history；影响：明文口令泄露；建议：只用交互式 `secret put`，`.dev.vars` 已被 `.gitignore` 忽略，绝不提交。**

---

## 排错

| 现象 | 原因与处理 |
| --- | --- |
| `login` 卡在 `localhost:8976` | 用 `npx --yes wrangler@4 login --device`；容器场景需映射 8976 端口 |
| `whoami` 报未登录 | 重新 `login`；或改用 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |
| `--dry-run` 报找不到 `dist` | 没跑 `h5:build`，或 `assets.directory` 相对路径不对 |
| 首次部署后 `/hg/health` 503 | 正常，还没配 `H5_ACCESS_KEY`，执行步骤 5 |
| `secret put` 报找不到 Worker | 顺序反了，先执行步骤 4 的 `h5:deploy` |
| 所有 RPC 401 | 未解锁 / 口令轮换后旧 Cookie 失效 / 浏览器拒绝 `Secure` Cookie |
| RPC 403 | Origin 非同源；本地 `vite dev` 联调需配 `H5_ALLOWED_ORIGIN=http://localhost:1420` |
| 封面 502「封面解密失败」 | 上游换了封面 AES key/IV，需同步 `workers/src/media.ts` 与 Rust 侧 `media.rs` |
| 播放黑屏 | 看 `/hg/hls` 是否为 m3u8、URI 是否全改写到 `/hg/seg`，再看分片 200/206 |
| 自定义域名证书一直 pending | 等几分钟；确认 zone active、没有冲突的 CNAME、SSL/TLS 模式为 Full 或 Full (strict) |
| 绑域名后 `*.workers.dev` 打不开 | `routes` 出现后 `workers_dev` 默认变 `false`，显式加 `workers_dev = true` |
| Error 1102 / 请求数耗尽 | 免费版 CPU 10ms 或 10 万/天触顶，看 `wrangler tail` 与 Dashboard 指标 |

## 方式 B：从 GitHub 拉取部署（Workers Builds）

对应截图里「创建应用 → Continue with GitHub → 选择存储库 → 创建和部署」这条路。Cloudflare 托管构建，push 到生产分支即部署；本机不需要 `wrangler login`、也不需要 API token。

### B1. 三条命令（平台无关，直接复制）

仓库已把命令收敛成 npm scripts，Builds 里不需要额外配置文件：

| 设置项 | 值 |
| --- | --- |
| Git repository | `pcicq/HGhub-Workers` |
| **Git branch** | **`master`**（官方默认填 `main`，本仓库必须手动改，见 B2 顶部警示） |
| 项目名称 | `hghub-workers-h5` |
| Root directory | `/`（默认，留空即可） |
| Build command | `npm run h5:build` |
| Deploy command | `npm run h5:deploy` |
| Preview command | `npm run h5:preview` |

说明：

- `h5:deploy` = `npx --yes wrangler@4 deploy --config workers/wrangler.toml`。**`--config` 不能省**：`wrangler.toml` 在 `workers/` 子目录，默认的 `npx wrangler deploy` 在仓库根找不到它，会触发官方的 autoconfig（自动提 PR 改你的仓库）。显式 `wrangler@4` 也避开了「Workers Builds 使用 package.json 里声明的 Wrangler 版本」这一行为——本仓库没把 wrangler 写进依赖，不改 lockfile。
- `h5:preview` = `npx --yes wrangler@4 versions upload --config workers/wrangler.toml`，**只上传版本、不自动上线生产**，比默认 `npx wrangler preview` 更安全。代价是生成 Version URL 而不是 Preview URL，PR 评论可能显示 `No Preview URL`；想要真正的 Preview URL 可换成 `npx --yes wrangler@4 preview --config workers/wrangler.toml`（open beta）。
- `h5:ci` = `h5:check` + `h5:build`，是给所有平台共用的质量门禁，Builds 不一定要用（它自己会跑 Build command）。

### B2. Dashboard 操作顺序

> 🔴 **本仓库特有的坑：生产分支必须选 `master`。** 远端 `main` 仍是上游 fork 的完整项目（`455f3ab`），里面没有 `workers/`，也没有 `h5:*` 脚本；H5 代码只在 `master`（`03c0afa`）。官方 Build settings 的 `Git branch` 说明是「Select the branch you would like Cloudflare to listen to for new commits. This will be defaulted to `main`」——照默认值连会拉到错误的代码，构建必然失败（典型症状：找不到 `workers/wrangler.toml`，或 `npm run h5:build` 报 `Missing script`）。创建时手动改成 `master`；已建好的在 `Settings` → `Build` → `Git branch` 改，**改完的配置对下一次构建生效**。

1. `Workers & Pages` → `Create application` → `Continue with GitHub` → 授权 Cloudflare GitHub App → 选仓库 `pcicq/HGhub-Workers`，**Git branch 选 `master`**。
   - 若已用方式 A 部署过同名 Worker，不能再 `Create application`：改走 `Workers & Pages` → 选中该 Worker → `Settings` → `Builds` → `Connect`。两条生产链路并存会轮流覆盖 Active Deployment，建议只保留一条。
2. **项目名称必须填 `hghub-workers-h5`**，与 `workers/wrangler.toml` 的 `name` 完全一致。官方明确要求 Dashboard 里的 Worker 名与配置文件的 `name` 匹配，否则构建失败。
3. 按 B1 填三条命令 → `Save and Deploy`。
4. 首次构建会创建 Worker，但此时 `/hg/health` 返回 **503**（还没配 `H5_ACCESS_KEY`），属预期，别把地址发出去。
5. 到 `Settings` → `Variables & Secrets` 添加 `H5_ACCESS_KEY`，类型选 **Secret**。⚠️ 不要填到 `Settings` → `Build` → `Build Variables and Secrets`——官方说明后者只在构建期生效，运行时读不到。
6. 重跑一次构建（push 一个 commit 或在 build history 里 Retry）——官方说明保存后的 build settings 只作用于**下一次**构建；再按步骤 6 的判据逐项验证。

### B3. 构建环境核对

官方 Workers Builds 构建镜像（[Build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)）：

| 项 | 默认值 | 备注 |
| --- | --- | --- |
| OS | Ubuntu 24.04 / x86_64 | — |
| Node.js | 24.22.1（预装 22.23.4） | 可用 `NODE_VERSION` 或 `.nvmrc` 覆盖；本项目本地与 Actions 都是 22 |
| pnpm | 9.10.0，经 Corepack 运行 | 按 lockfile 自动安装依赖；`SKIP_DEPENDENCY_INSTALL=1` 可关闭 |
| 注入变量 | `CI=true`、`WORKERS_CI=1`、`WORKERS_CI_COMMIT_SHA`、`WORKERS_CI_BRANCH`、`WORKERS_CI_BUILD_UUID` | 可用于区分构建来源 |
| 日志 | 构建与日志保留 90 天 | `Deployments` → `View build history` |

**版本不一致要留意**：本仓库 `pnpm-lock.yaml` 是 `lockfileVersion: '9.0'`；本地用 pnpm 12.21.0、GitHub Actions 用 pnpm 10、Builds 默认 9.10.0。若构建报 lockfile 不兼容，在 `Settings` → `Build` → `Build Variables` 加 `PNPM_VERSION=12.21.0`（官方优先级低于 `packageManager` 字段），或在 `package.json` 加 `"packageManager": "pnpm@12.21.0"`——后者会同时改变本地 `corepack pnpm` 选中的版本，改完需要重装依赖。

**已修复的实测坑（2026-11-15）**：某次构建日志显示 `Detected the following tools from environment: pnpm@10.11.1, nodejs@24.18.0`，但依赖安装阶段报 `ERROR packages field missing or empty` / `For help, run: pnpm help install`。根因是 `pnpm-workspace.yaml` 原本只写安装设置、没有 `packages` 字段——pnpm 9.x / <10.5 会把它当成空 workspace 直接拒装，pnpm 10.5+ 才允许省略该字段；日志里「检测到的版本」与「实际执行安装的版本」并不一致。本仓库已显式声明单包：

```yaml
packages:
  - "."
```

该写法在 pnpm 9.15.0 与 10.11.1 下均通过 `pnpm install --frozen-lockfile`，`pnpm-lock.yaml` 不变（`importers` 本来就是 `.`）。若仍报此错，说明拉到的提交不含该修复，**先确认 Git branch 是 `master`**；临时绕过可在 Build Variables 加 `PNPM_VERSION=10.11.1`。

### B4. 与 GitHub Actions 的分工

| 链路 | 做什么 | 凭据 |
| --- | --- | --- |
| `.github/workflows/ci.yml` 的 `h5` job | 跑 `pnpm h5:ci`：Worker 类型检查 + 契约校验 + 20 项冒烟 + 前端构建 | 无，**不部署** |
| Cloudflare Workers Builds | 从 GitHub 拉取、构建、部署到 CF 生产 | CF 自动生成 API token |
| 其它云平台 | 复用同一份 `dist/` 与 `h5:ci` 门禁 | 各平台自管，见 [h5-platforms.md](./h5-platforms.md) |

`master` 分支上的 `ci.yml` 只有一个 `h5` job（pnpm 10 + Node 22），`push` 触发器覆盖 `main` 与 `master`；但远端 `main` 是上游 fork 的旧 workflow，H5 门禁实际只在 `master` 生效。本仓库不含 Tauri / Rust 工程，因此没有 `frontend` / `rust` job，也不新增 workflow 文件。若想改用 GitHub Actions 部署到 CF，可自行加一个部署 job，凭据放 Repository Secrets；本仓库不预置，避免把部署凭据写进 CI 配置。

### B5. 方式 B 排错

| 现象 | 原因与处理 |
| --- | --- |
| 构建失败提示 Worker name 不匹配 | Dashboard 项目名必须等于 `hghub-workers-h5` |
| 构建日志找不到 `workers/wrangler.toml` / `Missing script: h5:build` | Git branch 用了默认的 `main`（上游 fork 内容，没有 workers/），改成 `master` 并触发一次新构建 |
| 出现 autoconfig 自动提的 PR | Deploy command 没带 `--config workers/wrangler.toml`，wrangler 在仓库根没找到配置 |
| `/hg/health` 一直 503 | `H5_ACCESS_KEY` 配到了 Build variables（构建期）而不是 Variables & Secrets（运行时） |
| 报找不到 `dist` | Build command 没跑成功，或 `assets.directory` 相对路径解析不对（相对 `workers/wrangler.toml`） |
| `ERROR packages field missing or empty` | 拉到的提交里 `pnpm-workspace.yaml` 缺 `packages`（pnpm 9.x 硬校验）；确认 Git branch = `master`，或临时加 `PNPM_VERSION=10.11.1`，详见 B3 |
| pnpm lockfile 报错 | 见 B3 的版本不一致处理 |
| 本地 CLI 与 Builds 互相覆盖版本 | 两条生产链路并存会轮流覆盖 Active Deployment，确定一条为准，另一条只用于本地 `--dry-run` |

## 参考

- [Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/) · [构建镜像](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/) · [Git 集成](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Wrangler 命令总览](https://developers.cloudflare.com/workers/wrangler/commands/) · [`deploy` / `dev`](https://developers.cloudflare.com/workers/wrangler/commands/workers/) · [`login` / `whoami`](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) · [Wrangler 配置](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Workers Static Assets（`run_worker_first`）](https://developers.cloudflare.com/workers/static-assets/binding) · [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains)
- [Limits](https://developers.cloudflare.com/workers/platform/limits/) · [Pricing](https://developers.cloudflare.com/workers/platform/pricing)

*本页命令与官方行为核对于 2026-11-15，wrangler 4.162.0。*
