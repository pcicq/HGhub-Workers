// H5 渠道的 RPC 命令表：把前端原本发给 Tauri invoke 的命令翻译成上游「边缘信封」。
// 契约对齐 src-tauri/src/api.rs（v2.1.0）：POST {base}/api/edge/request，
// body = { method, path, body(base64 JSON), content_type }，响应取 { status:1, data }。
import { APP_VERSION, DEFAULT_BASE, FIXED_LINES, SESSION_MAX_AGE, UA } from "./config";
import {
  allowedBases, defaultLine, emptySession, fetchGuarded, lineCookie, normalizeBase,
  readLine, readSession, sealLine, sealSession, sessionCookie,
  type Env, type LineConfig, type Session,
} from "./policy";
import { b64 } from "./policy";
import {
  autoCandidates, deadline, loadMirrors, verifyPublishedOrigin, type MirrorItem,
} from "./lines";

export type Args = Record<string, unknown>;
type Handler = (a: Args, c: RpcContext) => unknown | Promise<unknown>;

export interface RpcContext {
  env: Env;
  request: Request;
  base: string;
  line: LineConfig;
  session: Session;
  cookies: string[];
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  authed(method: string, path: string, body?: unknown): Promise<unknown>;
  account(method: string, path: string, body: unknown | undefined, a: Args): Promise<unknown>;
  setSession(session: Session | null): Promise<void>;
  setLine(base: string | null, custom?: boolean): Promise<void>;
}

const AUTO_PROBE_PATH = "/api/videos?page=1&size=1";
const PROBE_TIMEOUT_MS = 5_000;
/** 单次 RPC 的探测上限：桌面端可探 60 条，边缘平台要留子请求预算给其它命令 */
const PROBE_MAX = 24;
const PROBE_CHUNK = 6;

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

async function edgeAt(
  origin: string, method: string, path: string, body?: unknown, token?: string, signal?: AbortSignal,
): Promise<unknown> {
  const envelope = {
    method,
    path,
    body: body === undefined ? "" : b64(new TextEncoder().encode(JSON.stringify(body))),
    content_type: body === undefined ? "" : "application/json",
  };
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Referer": `${origin}/`,
    "User-Agent": UA,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  let response: Response;
  try {
    response = await fetchGuarded(`${origin}/api/edge/request`, {
      method: "POST", headers, body: JSON.stringify(envelope),
      ...(signal ? { signal } : {}),
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

const edge = (c: RpcContext, method: string, path: string, body?: unknown, token?: string): Promise<unknown> =>
  edgeAt(c.base, method, path, body, token);

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

/* ── 线路探测（对齐 lines.rs 的 probe_hit / healthy_video_data） ── */

interface Hit {
  tier: string;
  url: string;
  ok: boolean;
  reachable: boolean;
  ms: number;
  status: number | null;
  error?: string;
}

function healthyVideoData(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.items) || !root.pagination || typeof root.pagination !== "object") return false;
  const pagination = root.pagination as Record<string, unknown>;
  for (const key of ["page", "size", "pages", "total"]) {
    if (typeof pagination[key] !== "number") return false;
  }
  if ((pagination.page as number) <= 0 || (pagination.size as number) <= 0) return false;
  return root.items.every((item) => {
    const row = item && typeof item === "object" ? item as Record<string, unknown> : null;
    return !!row && typeof row.id === "number" && row.id > 0
      && typeof row.title === "string" && row.title.trim().length > 0;
  });
}

/** 用真实内容接口判定「通」，不带任何凭据；首页 HTML 200 不算可用 */
async function probeHit(tier: string, raw: string): Promise<Hit> {
  const hit: Hit = { tier, url: raw, ok: false, reachable: false, ms: 0, status: null };
  const origin = normalizeBase(raw);
  if (!origin) { hit.error = "线路必须是安全 HTTPS origin"; return hit; }
  hit.url = origin;
  const started = Date.now();
  const timer = deadline(PROBE_TIMEOUT_MS);
  try {
    const data = await edgeAt(origin, "GET", AUTO_PROBE_PATH, undefined, undefined, timer.signal);
    hit.reachable = true;
    hit.status = 200;
    hit.ok = healthyVideoData(data);
    if (!hit.ok) hit.error = "接口未返回有效视频列表数据";
  } catch (error) {
    hit.error = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
  } finally {
    hit.ms = Date.now() - started;
    timer.cancel();
  }
  return hit;
}

function hitJson(hit: Hit): Record<string, unknown> {
  const out: Record<string, unknown> = {
    tier: hit.tier, url: hit.url, ok: hit.ok, reachable: hit.reachable, ms: hit.ms, status: hit.status,
  };
  if (hit.error) out.error = hit.error;
  return out;
}

function pickFromHits(hits: Hit[]): Record<string, unknown> {
  const candidates = hits.map(hitJson);
  const winner = hits.filter((hit) => hit.ok).sort((a, b) => a.ms - b.ms)[0];
  if (!winner) return { base: "", tier: "none", ms: 0, reason: "all-down", candidates };
  return {
    base: winner.url, tier: winner.tier, ms: winner.ms,
    reason: winner.tier === "main" ? "main-ok" : "mirror-ok", candidates,
  };
}

/* ── 上下文构造 ─────────────────────────────────────────── */

export async function createRpcContext(request: Request, env: Env): Promise<RpcContext> {
  const line = await readLine(request, env);
  const base = line.base;
  const session = await readSession(request, env, base);
  const cookies: string[] = [];
  const ctx: RpcContext = {
    env, request, base, line, session, cookies,
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
    setLine: async (next, custom = false) => {
      if (!next) {
        cookies.push(lineCookie("", 0));
        ctx.line = defaultLine();
        ctx.base = DEFAULT_BASE;
      } else {
        // 与桌面端一致：把默认主站当作自定义保存时，不算自定义线路
        ctx.line = { base: next, custom: custom && next !== DEFAULT_BASE };
        cookies.push(lineCookie(await sealLine(env.H5_ACCESS_KEY, ctx.line), SESSION_MAX_AGE));
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

  /* 线路：与桌面端同语义，区别只在「上游请求由 Worker 代发、线路存加密 Cookie」 */
  "line_state": (_a, c) => ({
    base: c.base, default: DEFAULT_BASE, custom: c.line.custom, fixed: FIXED_LINES,
  }),
  "line_set": async (a, c) => {
    const next = normalizeBase(s(a, "url"));
    if (!next) throw "线路地址无效（需要纯 HTTPS 站点地址）";
    // 固定线路、服务端额外配置、可信发布页镜像才允许非显式自定义切换
    if (!allowedBases(c.env).includes(next) && !await verifyPublishedOrigin(next, c.base)) {
      throw "线路不在固定线路或可信发布页清单中";
    }
    if (next !== c.base) await c.setLine(next, false);
    return next;
  },
  "line_custom_set": async (a, c) => {
    const next = normalizeBase(s(a, "url"));
    if (!next) throw "线路地址无效（需要纯 HTTPS 站点地址，禁止内网）";
    await c.setLine(next, true);
    return { base: next, custom: c.line.custom };
  },
  "line_reset": async (_a, c) => { await c.setLine(null); return { base: DEFAULT_BASE, custom: false }; },
  "line_cancel": () => null,
  "line_mirrors": (_a, c) => loadMirrors(c.base),
  "line_probe": async (a) => {
    const urls = (Array.isArray(a.urls) ? a.urls : [])
      .filter((v): v is string => typeof v === "string").slice(0, PROBE_MAX);
    const out: Record<string, unknown>[] = [];
    for (let at = 0; at < urls.length; at += PROBE_CHUNK) {
      const hits = await Promise.all(urls.slice(at, at + PROBE_CHUNK).map((url) => probeHit("mirror", url)));
      for (const hit of hits) out.push(hitJson(hit));
    }
    return out;
  },
  "line_auto": async (_a, c) => {
    const previous = c.base;
    const hits: Hit[] = [await probeHit("main", FIXED_LINES[0].url)];
    let mirrorError: string | undefined;
    if (!hits[0].ok) {
      try {
        const listing = await loadMirrors(c.base);
        const candidates = autoCandidates(listing.items as MirrorItem[], c.base);
        const more = await Promise.all(candidates.map((url) => probeHit("mirror", url)));
        hits.push(...more);
      } catch (error) {
        mirrorError = error instanceof Error ? error.message : String(error);
      }
    }
    const pick = pickFromHits(hits);
    if (mirrorError) pick.mirror_error = mirrorError;
    let switched = false;
    if (pick.reason !== "all-down" && typeof pick.base === "string" && pick.base && pick.base !== c.base) {
      await c.setLine(pick.base, false);
      switched = true;
    }
    return { cancelled: false, previous, base: c.base, switched, pick };
  },
  "line_try_main": async (_a, c) => {
    const previous = c.base;
    const hit = await probeHit("main", FIXED_LINES[0].url);
    let switched = false;
    if (hit.ok && hit.url !== c.base) {
      await c.setLine(hit.url, false);
      switched = true;
    }
    return {
      cancelled: false, previous, base: c.base, switched,
      probe: { ok: hit.ok, base: hit.url, tier: "main", ms: hit.ms, status: hit.status },
    };
  },
  "line_health": async (_a, c) => {
    const hit = await probeHit("current", c.base);
    return { base: c.base, ok: hit.ok, ms: hit.ms, status: hit.status };
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
