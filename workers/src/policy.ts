// H5 渠道的安全边界：访问口令、同源校验、会话加解密、上游 URL 校验。
// 规则对齐 src-tauri/src/network_policy.rs 的 parse_target / allowed_ip，
// 不允许把 Worker 变成可访问任意地址的开放代理。
import { COOKIE_ACCESS, COOKIE_LINE, COOKIE_SESSION, DEFAULT_BASE, FIXED_LINES } from "./config";

export interface Env {
  /** Workers Assets 绑定 */
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  /** 访问口令，用 `wrangler secret put H5_ACCESS_KEY` 写入，不落仓库 */
  H5_ACCESS_KEY: string;
  /** 本地 vite dev 联调时额外放行的 Origin，逗号分隔 */
  H5_ALLOWED_ORIGIN?: string;
  /** 额外可信上游 origin，逗号分隔，必须是 HTTPS 根地址 */
  H5_EXTRA_BASES?: string;
}

export type Session = { origin: string; token: string; user: Record<string, unknown> | null };
export const emptySession = (origin: string): Session => ({ origin, token: "", user: null });

const encoder = new TextEncoder();

/* ── 编码辅助 ───────────────────────────────────────────── */

export function b64(bytes: Uint8Array<ArrayBuffer>): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function b64url(bytes: Uint8Array<ArrayBuffer>): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  const pad = value.length % 4 ? "=".repeat(4 - (value.length % 4)) : "";
  const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex(bytes: Uint8Array<ArrayBuffer>): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}

async function derivedKey(secret: string, label: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`${secret}|${label}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/* ── Cookie ─────────────────────────────────────────────── */

function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function cookieHeader(name: string, value: string, maxAge: number): string {
  // Secure 在生产域名下生效；SameSite=Lax 使跨站子资源请求不会带上凭据。
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/** 访问口令的 cookie 值是口令的 HMAC，不把明文写进浏览器 */
export async function accessSignature(secret: string): Promise<string> {
  return hmacHex(secret, "hghubx-h5-access-v1");
}

export function hasAccess(request: Request, signature: string): boolean {
  const presented = readCookie(request, COOKIE_ACCESS);
  return !!presented && timingSafeEqual(presented, signature);
}

export function accessCookie(value: string, maxAge: number): string {
  return cookieHeader(COOKIE_ACCESS, value, maxAge);
}

/** 校验表单里填的口令，比较派生值而不是明文 */
export async function keyMatches(secret: string, candidate: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    hmacHex(secret, "hghubx-h5-key-check-v1"),
    hmacHex(candidate, "hghubx-h5-key-check-v1"),
  ]);
  return timingSafeEqual(left, right);
}

/* ── 加密会话与线路 ─────────────────────────────────────── */

async function seal(secret: string, label: string, value: unknown): Promise<string> {
  const key = await derivedKey(secret, label);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, encoder.encode(JSON.stringify(value)),
  );
  return `${b64url(iv)}.${b64url(new Uint8Array(bytes))}`;
}

async function unseal<T>(secret: string, label: string, token: string): Promise<T | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const key = await derivedKey(secret, label);
    const bytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64url(parts[0]) }, key, fromB64url(parts[1]),
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

export async function sealSession(secret: string, session: Session): Promise<string> {
  return seal(secret, "session", session);
}

export async function sealLine(secret: string, base: string): Promise<string> {
  return seal(secret, "line", { base });
}

/** 会话与线路都绑定 origin：切换线路后旧 token 不会再被发给新站点 */
export async function readSession(request: Request, env: Env, base: string): Promise<Session> {
  const raw = readCookie(request, COOKIE_SESSION);
  const data = raw ? await unseal<Session>(env.H5_ACCESS_KEY, "session", raw) : null;
  if (!data || data.origin !== base || typeof data.token !== "string" || !data.token) {
    return emptySession(base);
  }
  return data;
}

export function sessionCookie(value: string, maxAge: number): string {
  return cookieHeader(COOKIE_SESSION, value, maxAge);
}

export function lineCookie(value: string, maxAge: number): string {
  return cookieHeader(COOKIE_LINE, value, maxAge);
}

/** 允许作为上游的 origin 白名单；只在服务端配置，前端不能注入 */
export function allowedBases(env: Env): string[] {
  const set = new Set<string>(FIXED_LINES.map((line) => line.url));
  for (const raw of (env.H5_EXTRA_BASES ?? "").split(",")) {
    const value = raw.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash
        && !url.username && !url.password) set.add(url.origin);
    } catch { /* 忽略无效配置 */ }
  }
  return [...set];
}

/** 读取用户选择的线路，只允许白名单内的值 */
export async function readLine(request: Request, env: Env): Promise<string> {
  const raw = readCookie(request, COOKIE_LINE);
  const data = raw ? await unseal<{ base: string }>(env.H5_ACCESS_KEY, "line", raw) : null;
  const bases = allowedBases(env);
  return data && bases.includes(data.base) ? data.base : DEFAULT_BASE;
}

/* ── 同源校验 ───────────────────────────────────────────── */

/** POST 必须带同源 Origin/Referer；GET 子资源（img/video）可能没有，靠 Lax Cookie 兜底 */
export function originOk(request: Request, env: Env, requireHeader: boolean): boolean {
  const allowed = new Set<string>([new URL(request.url).origin]);
  for (const raw of (env.H5_ALLOWED_ORIGIN ?? "").split(",")) {
    if (raw.trim()) allowed.add(raw.trim());
  }
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  let candidate: string | null = null;
  if (origin) candidate = origin;
  else if (referer) {
    try { candidate = new URL(referer).origin; } catch { return false; }
  }
  if (candidate) return allowed.has(candidate);
  return !requireHeader;
}

/* ── 上游目标校验（对齐 network_policy.rs） ───────────────── */

const INTERNAL_HOSTS = new Set(["tauri.localhost", "hg.localhost", "ipc.localhost"]);
const LOCAL_SUFFIXES = ["localhost", "local", "internal", "home.arpa"];

function ipv4Allowed(a: number, b: number, c: number): boolean {
  // FakeIP 198.18.0.0/15 是代理软件的兼容网段，明确放行
  if (a === 198 && (b === 18 || b === 19)) return true;
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113));
}

function ipv6Allowed(host: string): boolean {
  // WHATWG URL 的 hostname 对 IPv6 形如 [2001:db8::1]
  const inner = host.replace(/^\[|\]$/g, "").toLowerCase();
  const parts = inner.split(":");
  const first = Number.parseInt(parts[0] || "0", 16);
  const second = Number.parseInt(parts[1] || "0", 16);
  if (!Number.isFinite(first) || !Number.isFinite(second)) return false;
  if ((first & 0xe000) !== 0x2000) return false;   // 只认全球单播
  if (first === 0x2002) return false;               // 6to4 可封装私网 IPv4
  if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return false; // Teredo / 文档地址
  if (first === 0x3fff && second < 0x1000) return false;
  return true;
}

/** 解析并校验一个外部目标；拒绝非 HTTP(S)、认证信息、本机/内网/保留地址 */
export function parseTarget(raw: string): string {
  if (!raw || raw.length > 2048 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error("目标地址无效");
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("目标地址无效"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("目标只允许 HTTP(S) 地址");
  }
  if (url.username || url.password) {
    throw new Error("目标不允许携带认证信息");
  }
  const host = url.hostname.replace(/\.+$/, "").toLowerCase();
  if (INTERNAL_HOSTS.has(host)) throw new Error("禁止访问应用内部协议主机名");
  if (LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    throw new Error("禁止访问本机或内网主机名");
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    if ([a, b, c].some((n) => n > 255) || !ipv4Allowed(a, b, c)) {
      throw new Error("禁止访问普通内网、回环或保留地址");
    }
  } else if (host.startsWith("[") && !ipv6Allowed(host)) {
    throw new Error("禁止访问非全球单播 IPv6 地址");
  }
  return url.toString();
}

/**
 * 带守卫的上游请求：逐跳手动跟随重定向并重新校验目标，避免上游 302 到内网绕过白名单。
 * 带凭据的请求绝不跟随重定向（对齐 Rust 的 edge_redirect_target）。
 */
export async function fetchGuarded(rawUrl: string, init: RequestInit = {}, maxHops = 5): Promise<Response> {
  let current = parseTarget(rawUrl);
  const headers = new Headers(init.headers);
  const hasCredentials = headers.has("authorization") || headers.has("cookie");
  for (let hop = 0; hop <= maxHops; hop++) {
    const response = await fetch(current, { ...init, headers, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (hasCredentials) throw new Error("业务接口重定向已拒绝");
    const location = response.headers.get("location");
    if (!location || hop === maxHops) throw new Error("上游重定向次数超过限制");
    current = parseTarget(new URL(location, current).toString());
  }
  throw new Error("上游重定向次数超过限制");
}

export function json(value: unknown, status = 200, extra: HeadersInit = {}): Response {
  // 用 Headers 合并而不是对象展开：多个 Set-Cookie 必须全部保留
  const headers = new Headers(extra);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { status, headers });
}

export function text(value: string, status = 200, extra: HeadersInit = {}): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(value, { status, headers });
}
