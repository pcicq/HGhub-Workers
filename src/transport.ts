/**
 * 渠道判断走运行时：同一份 dist 既被 Tauri 打包（frontendDist），也被 Workers 托管（assets），
 * 不能用构建期常量区分。Tauri WebView 注入 __TAURI_INTERNALS__，浏览器没有。
 */
export const isH5 = typeof window !== "undefined"
  && typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === "undefined";

/** H5 媒体代理前缀，必须与 workers/src/config.ts 的 MEDIA_PREFIX 一致 */
export const H5_MEDIA = "/hg";
/** 能力探针版本，必须与 workers/src/config.ts 的 API_CONTRACT 一致 */
const API_CONTRACT = 1;

/** 不需要发到 Worker 的命令：平台专属能力在浏览器里降级为空操作或本地实现 */
export const LOCAL_COMMANDS: Record<string, (args: Record<string, unknown>) => unknown> = {
  "debug_log": () => null,
  "set_orientation": () => null,
  "set_text_interaction": () => null,
  "cache_clear": () => null,
  "playback_log_status": () => ({ enabled: false, path: null, error: null }),
  "playback_log_set": () => ({ enabled: false, path: null, error: null }),
  "playback_log_write": () => null,
  "playback_log_read": () => "",
  "plugin:app|exit": () => null,
  "open_url": (args) => {
    const url = typeof args.url === "string" ? args.url : "";
    // 只允许 http(s)，避免正文链接借 window.open 打开危险协议
    if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
    return null;
  },
  // 上游新增的原生媒体/电视迁移命令，H5 不涉及本地文件与 TV 数据。
  "media_http_origin": () => null,
  "tv_migration_complete": () => null,
};

/* ── 能力探针 ─────────────────────────────────────────────
 * 发请求前先确认对端是预期版本的 H5 网关：缺 channel/api 标记就刹停，
 * 不能把静态页或旧版网关的响应当成 RPC 成功继续走真实写入。 */

async function checkH5Health(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${H5_MEDIA}/health`, { credentials: "same-origin" });
  } catch (error) {
    throw `H5 网关不可达：${error instanceof Error ? error.message : String(error)}`;
  }
  if (!response.ok) throw `H5 网关返回 HTTP ${response.status}`;
  let info: Record<string, unknown>;
  try { info = await response.json() as Record<string, unknown>; }
  catch { throw "H5 网关探针响应不是 JSON"; }
  if (info.channel !== "h5" || info.api !== API_CONTRACT) {
    throw "H5 网关版本不匹配，请重新部署 Worker 后刷新页面";
  }
}

let health: Promise<void> | null = null;
export const probeH5 = (): Promise<void> => (health ??= checkH5Health());

/** invoke 的 H5 等价实现：命令名与参数形状保持与 Tauri 完全一致 */
export async function invokeCompat<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isH5) throw new Error("当前构建仅支持 H5 渠道");
  const local = LOCAL_COMMANDS[cmd];
  if (local) return local(args ?? {}) as T;

  await probeH5();
  let response: Response;
  try {
    response = await fetch(`${H5_MEDIA}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ cmd, args: args ?? {} }),
    });
  } catch (error) {
    throw `网络连接失败：${error instanceof Error ? error.message : String(error)}`;
  }
  if (response.status === 401) throw "访问口令已失效，请刷新页面重新输入";
  let payload: Record<string, unknown>;
  try { payload = await response.json() as Record<string, unknown>; }
  catch { throw `H5 网关响应无效（HTTP ${response.status}）`; }
  if (!response.ok) throw typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
  // 响应形状同样要校验：没有版本标记或 data 字段，说明走的不是预期网关
  if (payload.channel !== "h5" || payload.api !== API_CONTRACT || !("data" in payload)) {
    throw "H5 网关响应形状异常，已中止请求";
  }
  return payload.data as T;
}
