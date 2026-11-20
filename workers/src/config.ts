// H5 渠道与 Tauri 侧共用的常量。版本号直接取根 package.json，避免发版时两处漂移。
import pkg from "../../package.json";

export const APP_VERSION: string = pkg.version;
/** 能力探针版本：前端启动时会校验，防止把 RPC 发到旧版或错误网关 */
export const API_CONTRACT = 1;
export const CHANNEL = "h5";

/** 与 src-tauri/src/net.rs 的 UA 保持一致，上游按浏览器请求处理 */
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 与 src-tauri/src/net.rs 的 DEFAULT_BASE 一致 */
export const DEFAULT_BASE = "https://huangguoai.com";
/** 与上游 src-tauri/src/lines/mirror.rs 的 fixed() 一致；huangguoai.ai 只是导航页，不再作为 API 线路 */
export const FIXED_LINES = [
  { name: "固定线路 1", url: "https://huangguoai.com" },
];

/** 媒体代理前缀，必须与前端 src/shared/api/api.ts 在 H5 下的 LOCAL 一致 */
export const MEDIA_PREFIX = "/hg";
export const COOKIE_ACCESS = "hg_access";
export const COOKIE_SESSION = "hg_session";
export const COOKIE_LINE = "hg_line";
export const SESSION_MAX_AGE = 30 * 24 * 3600;
