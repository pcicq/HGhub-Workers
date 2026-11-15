// H5 渠道的 RPC 命令表：把前端原本发给 Tauri invoke 的命令翻译成上游「边缘信封」。
// 契约对齐 src-tauri/src/api.rs（v2.1.0）：POST {base}/api/edge/request，
// body = { method, path, body(base64 JSON), content_type }，响应取 { status:1, data }。
import { APP_VERSION, DEFAULT_BASE, FIXED_LINES, SESSION_MAX_AGE, UA } from "./config";
import {
  allowedBases, emptySession, fetchGuarded, lineCookie, readLine, readSession,
  sealLine, sealSession, sessionCookie, type Env, type Session,
} from "./policy";
import { b64 } from "./policy";

export type Args = Record<string, unknown>;
type Handler = (a: Args, c: RpcContext) => unknown | Promise<unknown>;

export interface RpcContext {
  env: Env;
  request: Request;
  base: string;
  session: Session;
  cookies: string[];
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  authed(method: string, path: string, body?: unknown): Promise<unknown>;
  account(method: string, path: string, body: unknown | undefined, a: Args): Promise<unknown>;
  setSession(session: Session | null): Promise<void>;
  setLine(base: string | null): Promise<void>;
}

/* ── 参数辅助 ───────────────────────────────────────────── */

const s = (a: Args, key: string, fallback = ""): string =>
  typeof a[key] === "string" ? (a[key] as string) : fallback;
const n = (a: Args, key: string, fallback = 0): number =>
  typeof a[key] === "number" && Number.isFinite(a[key]) ? (a[key] as number) : fallback;
const flag = (a: Args, key: string): boolean => a[key] === true;
const optional = (a: Args, key: string): string | undefined =>
  typeof a[key] === "string" && a[key] ? (a[key] as string) : undefined;
const idOf = (user: unknown): number | undefined =>
  user && typeof user === "object" && typeof (user as { id?: unknown }).id === "number"
    ? (user as { id: number }).id : undefined;

/** 对齐 Rust 的 url::form_urlencoded::byte_serialize：空格编码成 + */
function qs(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}
const sortPart = (a: Args): string => {
  const sort = s(a, "sort").trim();
  return sort ? `&sort=${qs(sort)}` : "";
};

/* ── 上游边缘信封 ───────────────────────────────────────── */

async function edge(c: RpcContext, method: string, path: string, body?: unknown, token?: string): Promise<unknown> {
  const envelope = {
    method,
    path,
    body: body === undefined ? "" : b64(new TextEncoder().encode(JSON.stringify(body))),
    content_type: body === undefined ? "" : "application/json",
  };
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Referer": `${c.base}/`,
    "User-Agent": UA,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetchGuarded(`${c.base}/api/edge/request`, {
      method: "POST", headers, body: JSON.stringify(envelope),
    });
  } catch (error) {
    // 与 Rust 的 err_text 一样带上链路特征，前端 call() 才会识别为可重试的网络失败
    throw `网络连接失败：${error instanceof Error ? error.message : String(error)}`;
  }
  const text = await response.text();
  if (response.status === 401 || response.status === 403) throw "401";
  if (!response.ok) throw `HTTP ${response.status}: ${text.slice(0, 160)}`;
  if (!text.trim()) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(text) as Record<string, unknown>; }
  catch { throw `接口返回不是 JSON: ${text.slice(0, 160)}`; }
  if (value.status === 1) return value.data ?? null;
  throw typeof value.msg === "string" && value.msg ? value.msg : "接口返回失败";
}

/* ── 账号快照（对齐 api.rs 的 normalize_account） ─────────── */

const PROFILE_KEYS = [
  "id", "username", "nickname", "avatar", "avatar_color", "sign", "desc",
  "user_type", "counts", "interactions",
];

function normalizeAccount(value: unknown, origin: string): { user: Record<string, unknown>; origin: string; interactions?: unknown } {
  const root = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const wrapped = root.user && typeof root.user === "object" && !Array.isArray(root.user)
    ? root.user as Record<string, unknown> : root;
  const user: Record<string, unknown> = {};
  for (const key of PROFILE_KEYS) if (wrapped[key] !== undefined) user[key] = wrapped[key];
  if (!idOf(user) || idOf(user)! <= 0) throw "账号资料响应无效，请重新登录";
  const interactions = root.interactions ?? user.interactions;
  if (interactions !== undefined) user.interactions = interactions;
  const result: { user: Record<string, unknown>; origin: string; interactions?: unknown } = { user, origin };
  if (interactions !== undefined) result.interactions = interactions;
  return result;
}

/** 对齐 api.rs 的 normalize_account_history：只保留 video 类型与可信字段 */
function normalizeAccountHistory(value: unknown): unknown {
  const root = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (!Array.isArray(root.items) || !root.pagination || typeof root.pagination !== "object") {
    throw "观看历史响应无效";
  }
  const pagination = root.pagination as Record<string, unknown>;
  for (const field of ["page", "pages", "size", "total"]) {
    if (typeof pagination[field] !== "number") throw "观看历史分页信息无效";
  }
  const items = root.items.map((item) => {
    const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (row.target_type !== "video" || typeof row.id !== "number" || typeof row.video_id !== "number") return null;
    if (row.id <= 0 || row.video_id <= 0) return null;
    return {
      id: row.id, video_id: row.video_id, target_type: "video",
      last_ep: Math.max(1, typeof row.last_ep === "number" ? row.last_ep : 1),
      updated_at: typeof row.updated_at === "string" ? row.updated_at : "",
    };
  }).filter(Boolean);
  return { items, pagination };
}

/** 对齐 api.rs 的 account_session：身份与线路必须与当前会话一致，防串号 */
function accountSession(c: RpcContext, a: Args): Session {
  if (!c.session.token) throw "请先登录";
  const expectedUserId = typeof a.expectedUserId === "number" ? a.expectedUserId : undefined;
  const expectedOrigin = optional(a, "expectedOrigin");
  if ((expectedOrigin !== undefined && expectedOrigin !== c.base)
    || (expectedUserId !== undefined && idOf(c.session.user) !== expectedUserId)) {
    throw "账号或线路已变化，请重试";
  }
  return c.session;
}

/** 对齐 api.rs 的 normalize_play_info：把 streams 回填到旧字段 */
function normalizePlay(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const info = value as Record<string, unknown>;
  const streams = (info.streams && typeof info.streams === "object" ? info.streams : {}) as Record<string, unknown>;
  for (const [field, key] of [["video_url", "main"], ["video_url_hevc", "hevc"]] as const) {
    const stream = streams[key];
    if (typeof stream === "string" && stream.trim()
      && (typeof info[field] !== "string" || !(info[field] as string).trim())) {
      info[field] = stream;
    }
  }
  return info;
}

const hasPlayUrl = (value: unknown): boolean =>
  !!value && typeof value === "object"
  && typeof (value as Record<string, unknown>).video_url === "string"
  && !!(value as Record<string, unknown>).video_url;

/* ── 热搜：官网 SSR 片段的 best-effort 解析，失败返回空列表 ── */

function decodeEntities(raw: string): string {
  return raw.replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ").trim();
}

async function hotSearch(c: RpcContext): Promise<unknown> {
  try {
    const response = await fetchGuarded(`${c.base}/search/?_hghubx_hot=${Date.now()}`, {
      headers: { "Accept": "text/html", "Referer": `${c.base}/`, "User-Agent": UA },
    });
    if (!response.ok) return { items: [] };
    const html = (await response.text()).slice(0, 2 * 1024 * 1024);
    const section = /<section[^>]*class="[^"]*hg-search-hot[^"]*"[^>]*>[\s\S]*?<\/section>/i.exec(html)?.[0] ?? "";
    const items: { video_id: number; title: string; plays: string }[] = [];
    const seen = new Set<number>();
    const blocks = section.matchAll(/<a\b[^>]*class="[^"]*hg-search-hot__item[^"]*"[^>]*>[\s\S]*?<\/a>/gi);
    for (const match of blocks) {
      const block = match[0];
      const id = Number(/href="\/video\/(\d+)\/?"/i.exec(block)?.[1]);
      if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
      const title = decodeEntities(/class="[^"]*hg-search-hot__name[^"]*"[^>]*>([\s\S]*?)<\//i.exec(block)?.[1] ?? "");
      const plays = decodeEntities(/class="[^"]*hg-search-hot__plays[^"]*"[^>]*>([\s\S]*?)<\//i.exec(block)?.[1] ?? "");
      if (!title || !plays) continue;
      seen.add(id);
      items.push({ video_id: id, title, plays });
      if (items.length >= 20) break;
    }
    return { items };
  } catch {
    return { items: [] };
  }
}

/* ── 线路探测（只碰白名单，不带凭据） ───────────────────── */

async function probeLine(url: string): Promise<{ url: string; ok: boolean; status?: number; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const response = await fetchGuarded(url, {
      method: "GET",
      headers: { "Accept": "text/html", "User-Agent": UA },
    });
    return { url, ok: response.ok, status: response.status, ms: Date.now() - started };
  } catch (error) {
    return { url, ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

/* ── 上下文构造 ─────────────────────────────────────────── */

export async function createRpcContext(request: Request, env: Env): Promise<RpcContext> {
  const base = await readLine(request, env);
  const session = await readSession(request, env, base);
  const cookies: string[] = [];
  const ctx: RpcContext = {
    env, request, base, session, cookies,
    get: (path) => edge(ctx, "GET", path, undefined, session.token || undefined),
    post: (path, body) => edge(ctx, "POST", path, body, session.token || undefined),
    authed: (method, path, body) => {
      if (!session.token) throw "请先登录";
      return edge(ctx, method, path, body, session.token);
    },
    account: (method, path, body, a) => {
      const current = accountSession(ctx, a);
      return edge(ctx, method, path, body, current.token);
    },
    setSession: async (next) => {
      if (!next) {
        cookies.push(sessionCookie("", 0));
        ctx.session = emptySession(base);
      } else {
        cookies.push(sessionCookie(await sealSession(env.H5_ACCESS_KEY, next), SESSION_MAX_AGE));
        ctx.session = next;
      }
    },
    setLine: async (next) => {
      if (!next) {
        cookies.push(lineCookie("", 0));
        ctx.base = DEFAULT_BASE;
      } else {
        cookies.push(lineCookie(await sealLine(env.H5_ACCESS_KEY, next), SESSION_MAX_AGE));
        ctx.base = next;
      }
      // 线路变化即丢弃会话，避免把旧站点 token 发给新站点
      cookies.push(sessionCookie("", 0));
      ctx.session = emptySession(ctx.base);
    },
  };
  return ctx;
}

/* ── 命令表 ─────────────────────────────────────────────── */

/* __RPC_COMMANDS_START__ */
const COMMANDS: Record<string, Handler> = {
  "app_boot": (_a, c) => ({
    user: c.session.user, logged_in: !!c.session.token, base: c.base,
    strict_security: true, cli_relaxed: false,
  }),
  "security_set": () => true, // H5 侧固定严格模式，不提供关闭入口
  "debug_log": () => null,    // 不把用户数据写进 Worker 日志
  "net_diag": () => ({}),
  "cache_clear": () => null,

  "api_login": async (a, c) => {
    const data = await edge(c, "POST", "/api/account/loginByPassword",
      { username: s(a, "username"), password: s(a, "password") });
    const token = (data as Record<string, unknown> | null)?.token;
    if (typeof token !== "string" || !token) throw "登录返回缺少 token";
    const account = normalizeAccount(data, c.base);
    await c.setSession({ origin: c.base, token, user: account.user });
    return account;
  },
  "api_register": async (a, c) => {
    const email = s(a, "email").trim();
    const body: Record<string, unknown> = {
      username: s(a, "username"), password: s(a, "password"), confirm_password: s(a, "password"),
    };
    if (email) body.email = email;
    const data = await edge(c, "POST", "/api/account/registerByPassword", body);
    const token = (data as Record<string, unknown> | null)?.token;
    if (typeof token !== "string" || !token) throw "注册返回缺少 token";
    const account = normalizeAccount(data, c.base);
    await c.setSession({ origin: c.base, token, user: account.user });
    return account;
  },
  "api_logout": async (a, c) => {
    const current = accountSession(c, a);
    try { await edge(c, "POST", "/api/account/logout", undefined, current.token); } catch { /* 忽略上游失败 */ }
    await c.setSession(null);
    return { ok: true };
  },
  "api_me": async (a, c) => {
    const current = accountSession(c, a);
    const me = await edge(c, "GET", "/api/account/me", undefined, current.token);
    const account = normalizeAccount(me, c.base);
    await c.setSession({ origin: c.base, token: current.token, user: account.user });
    return account;
  },
  "api_account_history": async (a, c) => normalizeAccountHistory(await c.account("GET",
    `/api/users/me/history?page=${Math.max(1, n(a, "page", 1))}&size=${Math.min(100, Math.max(1, n(a, "size", 50)))}`,
    undefined, a)),
  "api_account_history_record": (a, c) => {
    const videoId = n(a, "videoId"), ep = n(a, "ep");
    if (videoId <= 0 || ep <= 0) throw "观看记录参数无效";
    return c.account("POST", "/api/users/me/history", { video_id: videoId, ep }, a);
  },
  "api_account_history_delete": (a, c) => {
    const ids = Array.isArray(a.ids) ? a.ids.filter((v): v is number => typeof v === "number" && v > 0) : [];
    if (!ids.length || ids.length > 200) throw "观看记录参数无效";
    return c.account("POST", "/api/users/me/history/delete", { ids }, a);
  },

  "api_feed": (a, c) => c.get(`/api/videos?page=${n(a, "page", 1)}&size=${n(a, "size", 20)}`),
  "api_original_videos": (a, c) => {
    const cate = s(a, "cate");
    const path = cate === "all" ? "/api/videos" : `/api/videos/category/${qs(cate)}`;
    return c.get(`${path}?is_original=1&page=${n(a, "page", 1)}&size=${n(a, "size", 20)}${sortPart(a)}`);
  },
  "api_topics": (_a, c) => c.get("/api/topics?size=100"),
  "api_topic": (a, c) => c.get(`/api/topics/${qs(s(a, "slug"))}`),
  "api_tags": (_a, c) => c.get("/api/tags"),
  "api_tag_videos": (a, c) => c.get(`/api/videos/tag/${qs(s(a, "tag"))}?page=${n(a, "page", 1)}&size=${n(a, "size", 20)}`),
  "api_category": (a, c) => c.get(`/api/videos/category/${qs(s(a, "cate"))}?page=${n(a, "page", 1)}&size=${n(a, "size", 20)}${sortPart(a)}`),
  "api_rank": (a, c) => {
    const kind = ["hot", "recommend", "potential"].includes(s(a, "kind")) ? s(a, "kind") : "hot";
    return c.get(`/api/ranks/${kind}`);
  },
  "api_search": (a, c) => {
    const kind = optional(a, "kind");
    const scope = kind === "post" || kind === "video" ? `&type=${kind}` : "";
    return c.get(`/api/search?q=${qs(s(a, "q"))}&page=${n(a, "page", 1)}&size=${n(a, "size", 20)}${scope}`);
  },
  "api_search_hot": (_a, c) => hotSearch(c),
  "api_posts": (a, c) => c.get(`/api/posts?page=${n(a, "page", 1)}&size=${n(a, "size", 20)}${sortPart(a)}`),
  "api_post": (a, c) => c.get(`/api/posts/${n(a, "id")}`),
  "api_post_playback": (a, c) => c.post(`/api/posts/${n(a, "id")}/playback`, {}),

  "api_video": (a, c) => c.get(`/api/videos/${n(a, "id")}`),
  "api_play": async (a, c) => {
    const id = n(a, "id"), ep = n(a, "ep");
    let primary: unknown = null;
    let primaryError: unknown = null;
    try { primary = normalizePlay(await c.post(`/api/videos/${id}/episodes/${ep}/playback`, {})); }
    catch (error) { primaryError = error; }
    if (hasPlayUrl(primary)) return primary;
    try {
      const legacy = normalizePlay(await c.get(`/api/videos/${id}/play?ep=${ep}&page_texts=0`));
      if (hasPlayUrl(legacy) || primaryError) return legacy;
      return primary ?? legacy;
    } catch {
      if (primaryError) throw primaryError;
      return primary;
    }
  },
  "api_comments": (a, c) => c.get(`/api/videos/${n(a, "id")}/comments?ep=${n(a, "ep")}&page=${n(a, "page", 1)}&size=${n(a, "size", 20)}`),
  "api_comment_send": (a, c) => {
    const body: Record<string, unknown> = { text: s(a, "text") };
    const replyId = n(a, "replyId");
    const path = replyId > 0
      ? `/api/videos/${n(a, "id")}/comments`
      : `/api/videos/${n(a, "id")}/comments?ep=${n(a, "ep")}`;
    if (replyId > 0) body.reply_id = replyId;
    return c.authed("POST", path, body);
  },
  "api_related": (a, c) => c.get(`/api/videos/${n(a, "id")}/related`),
  "api_following": (a, c) => c.authed("GET", `/api/videos/following?page=${n(a, "page", 1)}&size=${n(a, "size", 20)}`),
  "api_user": (a, c) => c.get(`/api/users/${n(a, "id")}`),
  "api_user_stats": (a, c) => c.get(`/api/users/${n(a, "id")}/stats`),
  "api_user_videos": (a, c) => c.get(`/api/videos/user/${n(a, "id")}?page=${n(a, "page", 1)}&size=${n(a, "size", 20)}`),
  "api_like": (a, c) => c.account(flag(a, "on") ? "POST" : "DELETE", `/api/videos/${n(a, "id")}/like?ep=${n(a, "ep")}`, undefined, a),
  "api_collect": (a, c) => c.account(flag(a, "on") ? "POST" : "DELETE", `/api/videos/${n(a, "id")}/collect`, undefined, a),
  "api_follow": (a, c) => c.account(flag(a, "on") ? "POST" : "DELETE", `/api/users/${n(a, "uid")}/follow`, undefined, a),
  "api_post_like": (a, c) => c.account(flag(a, "on") ? "POST" : "DELETE", `/api/posts/${n(a, "id")}/like`, undefined, a),
  "api_post_collect": (a, c) => c.account(flag(a, "on") ? "POST" : "DELETE", `/api/posts/${n(a, "id")}/collect`, undefined, a),
  "api_post_comments": (a, c) => c.get(`/api/posts/${n(a, "id")}/comments?page=${n(a, "page", 1)}&size=${n(a, "size", 20)}`),
  "api_post_categories": (_a, c) => c.get("/api/site/categories/post"),
  "api_post_category": (a, c) => c.get(`/api/posts/category/${qs(s(a, "route"))}?page=${n(a, "page", 1)}&size=${n(a, "size", 20)}${sortPart(a)}`),

  /* 线路：H5 只允许固定白名单，不开放自定义 / 镜像发布页 */
  "line_state": (_a, c) => ({ base: c.base, default: DEFAULT_BASE, custom: false, fixed: FIXED_LINES }),
  "line_set": async (a, c) => {
    const next = s(a, "url");
    if (!allowedBases(c.env).includes(next)) throw "H5 渠道只允许切换固定线路";
    if (next !== c.base) await c.setLine(next);
    return next;
  },
  "line_custom_set": () => { throw "H5 渠道不支持自定义线路，请在服务端白名单中配置"; },
  "line_reset": async (_a, c) => { await c.setLine(DEFAULT_BASE); return { base: DEFAULT_BASE, custom: false }; },
  "line_cancel": () => null,
  "line_mirrors": () => ({ source: "h5", items: [], recommended: [] }),
  "line_probe": async (a) => {
    const urls = (Array.isArray(a.urls) ? a.urls : [])
      .filter((v): v is string => typeof v === "string").slice(0, 5);
    return Promise.all(urls.map(probeLine));
  },
  "line_auto": (_a, c) => ({
    cancelled: true, previous: c.base, base: c.base, switched: false,
    pick: { base: c.base, tier: "none", ms: 0, reason: "h5-fixed-line", candidates: [] },
  }),
  "line_try_main": (_a, c) => ({
    cancelled: true, previous: c.base, base: c.base, switched: false,
    probe: { ok: false, base: c.base, tier: "main", ms: 0, status: null },
  }),
  "line_health": async (_a, c) => {
    const started = Date.now();
    try { await c.get("/api/videos?page=1&size=1"); return { base: c.base, ok: true, ms: Date.now() - started, status: 200 }; }
    catch { return { base: c.base, ok: false, ms: Date.now() - started, status: null }; }
  },

  /* 应用内代理 / 更新检查：由 Cloudflare 出口与发版流程接管 */
  "proxy_state": () => ({ mode: "off", url: "", effective: null, system_proxy: false, env_proxy: false }),
  "proxy_set": () => { throw "H5 渠道不支持应用内代理"; },
  "proxy_test": () => { throw "H5 渠道不支持应用内代理"; },
  "check_update": () => ({ has_update: false, current: APP_VERSION, latest: APP_VERSION, url: "" }),
  "open_url": () => null, // 前端本地 window.open，不经 Worker

  /* 平台专属命令：H5 下由前端本地拦截或作为兜底 no-op */
  "set_orientation": () => null,
  "set_text_interaction": () => null,
  "plugin:app|exit": () => null,
  "playback_log_status": () => ({ enabled: false, path: null, error: null }),
  "playback_log_set": () => ({ enabled: false, path: null, error: null }),
  "playback_log_write": () => null,
  "playback_log_read": () => "",
};
/* __RPC_COMMANDS_END__ */

export async function dispatchRpc(cmd: string, args: Args, ctx: RpcContext): Promise<unknown> {
  const handler = COMMANDS[cmd];
  if (!handler) throw `未知命令: ${cmd}`;
  return handler(args, ctx);
}
