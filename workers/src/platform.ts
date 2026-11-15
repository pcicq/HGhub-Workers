// 平台适配契约：default.fetch(request, env) 本身已是 WinterTC 形态的入口，
// 非 Cloudflare 运行时只需把本平台的配置读取与静态资源实现包装成 Env，
// 就能复用全部业务逻辑，不需要改动路由、解密、CSP 等核心代码。
import type { Env } from "./policy";

/** 各平台必须提供的两项能力；差异只收敛在这里 */
export interface PlatformAdapter {
  /** 读取运行时配置：CF 是 env 绑定，Deno 是 Deno.env，Node/Bun 是 process.env */
  get(name: string): string | undefined;
  /** 按请求路径取静态资源：CF 是 ASSETS 绑定，其它平台需自行实现或交给平台静态托管 */
  fetchAsset(request: Request): Promise<Response>;
}

/** 缺口令时留空串，由 /hg/health 返回 503，避免网关误判可用 */
export function createEnv(adapter: PlatformAdapter): Env {
  return {
    H5_ACCESS_KEY: adapter.get("H5_ACCESS_KEY") ?? "",
    H5_ALLOWED_ORIGIN: adapter.get("H5_ALLOWED_ORIGIN"),
    H5_EXTRA_BASES: adapter.get("H5_EXTRA_BASES"),
    ASSETS: { fetch: (request) => adapter.fetchAsset(request) },
  };
}
