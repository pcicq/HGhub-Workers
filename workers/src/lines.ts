// H5 线路数据源：对齐 src-tauri/src/lines.rs 的地址发布页解析与可信镜像模型。
// 发布脚本只按「顶层 var/let/const 字面量字符串数组」解析，绝不执行远端 JS。
// 所有上游请求都经过 policy.ts 的 parseTarget / fetchGuarded 守卫。
import { FIXED_LINES, UA } from "./config";
import { fetchGuarded, normalizeBase } from "./policy";

export const PUBLISH_PAGES = [
  "https://huangguoai.pages.dev/",
  "https://huang-guo.pages.dev/",
];

const MIRROR_MAX = 60;
const PUBLISH_ARRAY_MAX = 256;
const RECOMMENDED_MAX = 20;
const TRUST_MAX = 256;
const AUTO_MIRROR_MAX = 10;
const PAGE_TIMEOUT_MS = 8_000;
const MAX_PUBLISH_BYTES = 512 * 1024;

export type MirrorItem = { url: string; host: string };
export type MirrorListing = {
  source: string;
  script: string;
  items: MirrorItem[];
  recommended_source: string;
  recommended: MirrorItem[];
  errors: string[];
};

interface PublishedPage {
  source: string;
  script: string;
  items: MirrorItem[];
}

/** 只有真正从可信发布页解析出来的 origin 才能进入可信集合 */
const trusted = new Set<string>();

export function isFixed(url: string): boolean {
  return FIXED_LINES.some((line) => line.url === url);
}

export function isTrustedMirror(url: string): boolean {
  return trusted.has(url);
}

/**
 * 平台无关的超时信号：AbortSignal.timeout 不属于 WinterTC Minimum Common API，
 * 接其它边缘运行时时不保证存在，这里用 AbortController + setTimeout 兜底。
 */
export function deadline(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

/* ── 发布页 / 发布脚本取回 ───────────────────────────────── */

async function getText(raw: string, signal: AbortSignal): Promise<string> {
  const target = new URL(raw);
  const response = await fetchGuarded(raw, {
    method: "GET",
    headers: { "Accept": "text/html,application/javascript", "User-Agent": UA },
    signal,
  });
  // fetchGuarded 逐跳手动跟随重定向；这里再复核最终地址没有跨 origin 或换路径
  const finalUrl = new URL(response.url || raw);
  if (finalUrl.protocol !== "https:" || finalUrl.origin !== target.origin
    || (target.pathname.endsWith("/publish.js") && finalUrl.pathname !== target.pathname)) {
    throw new Error("发布页或发布脚本跳转到了非可信地址");
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_PUBLISH_BYTES) {
    throw new Error("地址发布页或脚本超过 512 KiB 限制");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_PUBLISH_BYTES) {
    throw new Error("地址发布页或脚本超过 512 KiB 限制");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("地址发布页或脚本不是有效 UTF-8");
  }
}

/** 只接受发布页同源、末段为 publish.js 的 HTTPS 脚本地址 */
function absolute(base: string, relative: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(relative)) return null;
  try {
    const from = new URL(base);
    const target = new URL(relative.trim(), from);
    if (from.protocol !== "https:" || target.protocol !== "https:" || target.origin !== from.origin
      || target.username || target.password || target.hash
      || target.pathname.split("/").pop() !== "publish.js") return null;
    return target.toString();
  } catch {
    return null;
  }
}

function scriptSrc(page: string, html: string): string {
  const tags = html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi);
  for (const match of tags) {
    const src = match[1] ?? match[2] ?? match[3] ?? "";
    const script = absolute(page, src);
    if (script) return script;
  }
  throw new Error("地址发布页没有同源 publish.js 脚本");
}

/* ── 发布脚本字面量解析（对齐 lines.rs 的保守词法器） ─────── */

type Token = { kind: "ident" | "quoted" | "symbol" | "other"; value?: string; ch?: number };

function jsTokens(source: string): Token[] {
  const out: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source.charCodeAt(at);
    if (/\s/.test(source[at])) { at++; continue; }
    if (source.startsWith("//", at)) {
      at += 2;
      while (at < source.length && source.charCodeAt(at) !== 10) at++;
      continue;
    }
    if (source.startsWith("/*", at)) {
      const end = source.indexOf("*/", at + 2);
      if (end < 0) throw new Error("发布脚本注释未闭合");
      at = end + 2;
      continue;
    }
    if (ch === 39 || ch === 34 || ch === 96) {
      const start = at;
      at++;
      while (at < source.length && source.charCodeAt(at) !== ch) {
        if (source.charCodeAt(at) === 92) at++;
        at++;
      }
      if (at >= source.length) throw new Error("发布脚本字符串未闭合");
      at++;
      // 模板字符串按「其它」处理，不能引入声明
      out.push(ch === 96 ? { kind: "other" } : { kind: "quoted", value: source.slice(start, at) });
      continue;
    }
    if (ch === 47) {
      // '/' 一律按正则处理：发布数据不需要算术，歧义输入一律失败关闭
      at++;
      let inClass = false;
      while (at < source.length) {
        const c = source.charCodeAt(at);
        if (c === 92) { at += 2; continue; }
        if (c === 91) inClass = true;
        else if (c === 93) inClass = false;
        else if (c === 47 && !inClass) break;
        else if (c === 10 || c === 13) throw new Error("发布脚本包含不支持的表达式");
        at++;
      }
      if (at >= source.length) throw new Error("发布脚本表达式未闭合");
      at++;
      while (at < source.length && /[a-z]/i.test(source[at])) at++;
      out.push({ kind: "other" });
      continue;
    }
    if (/[a-z_$]/i.test(source[at])) {
      const start = at;
      at++;
      while (at < source.length && /[a-z0-9_$]/i.test(source[at])) at++;
      out.push({ kind: "ident", value: source.slice(start, at) });
    } else {
      out.push({ kind: "symbol", ch });
      at++;
    }
  }
  return out;
}

function jsString(raw: string): string {
  let result = "";
  const inner = raw.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      if (/[\u0000-\u001f\u007f]/.test(ch)) throw new Error("镜像字符串含控制字符");
      result += ch;
      continue;
    }
    const esc = inner[++i];
    if (esc === "\\" || esc === "'" || esc === '"' || esc === "/") { result += esc; continue; }
    if (esc === "x" || esc === "u") {
      const size = esc === "x" ? 2 : 4;
      const code = inner.slice(i + 1, i + 1 + size);
      if (code.length !== size || !new RegExp(`^[0-9a-fA-F]{${size}}$`).test(code)) {
        throw new Error("镜像字符串转义无效");
      }
      const number = Number.parseInt(code, 16);
      if (esc === "u" && !Number.isFinite(number)) throw new Error("镜像字符串转义无效");
      result += String.fromCharCode(number);
      i += size;
      continue;
    }
    throw new Error("镜像字符串含不支持的转义");
  }
  return result;
}

/** 只认顶层 var/let/const 的字面量字符串数组；重复声明 / 动态表达式一律失败关闭 */
function jsArray(source: string, name: string): string[] | null {
  const tokens = jsTokens(source);
  let depth = 0;
  let result: string[] | null = null;
  const symbol = (token: Token | undefined, code: number): boolean =>
    token?.kind === "symbol" && token.ch === code;
  for (let at = 0; at < tokens.length; at++) {
    const token = tokens[at];
    const declaration = token.kind === "ident"
      && ["var", "let", "const"].includes(token.value ?? "");
    if (depth === 0 && declaration
      && tokens[at + 1]?.kind === "ident" && tokens[at + 1].value === name) {
      if (result !== null) throw new Error(`发布脚本重复声明 ${name}`);
      if (!symbol(tokens[at + 2], 61) || !symbol(tokens[at + 3], 91)) {
        throw new Error(`发布脚本的 ${name} 必须是字符串数组`);
      }
      let cursor = at + 4;
      const values: string[] = [];
      while (!symbol(tokens[cursor], 93)) {
        const current = tokens[cursor];
        if (!current || current.kind !== "quoted" || current.value === undefined) {
          throw new Error(`发布脚本的 ${name} 含非字符串值`);
        }
        if (values.length >= PUBLISH_ARRAY_MAX) {
          throw new Error(`${name} exceeds the publisher array size limit`);
        }
        values.push(jsString(current.value));
        cursor++;
        if (symbol(tokens[cursor], 44)) cursor++;
        else if (!symbol(tokens[cursor], 93)) {
          throw new Error(`发布脚本的 ${name} 数组格式无效`);
        }
      }
      const after = tokens[cursor + 1];
      if (after && !symbol(after, 59)) {
        throw new Error(`发布脚本的 ${name} 不能使用动态表达式`);
      }
      result = values;
    }
    if (symbol(token, 123) || symbol(token, 40) || symbol(token, 91)) depth++;
    else if (symbol(token, 125) || symbol(token, 41) || symbol(token, 93)) depth = Math.max(0, depth - 1);
  }
  return result;
}

function validDnsLabel(value: string): boolean {
  return value.length > 0 && value.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(value);
}

function validDnsName(value: string): boolean {
  return value.length <= 253 && value.includes(".") && value.split(".").every(validDnsLabel)
    && !["localhost", "local", "internal", "home.arpa"]
      .some((suffix) => value === suffix || value.endsWith(`.${suffix}`));
}

export function parseMirrors(js: string): MirrorItem[] {
  const domains = jsArray(js, "urls") ?? [];
  const subs = jsArray(js, "subdomains") ?? [];
  if (!domains.length) throw new Error("发布脚本中没有找到镜像域名");
  const items: MirrorItem[] = [];
  const seen = new Set<string>();
  outer: for (const raw of domains) {
    const domain = raw.trim().replace(/\/+$/, "").toLowerCase();
    if (!validDnsName(domain)) continue;
    const hosts = subs.length
      ? subs.map((sub) => sub.trim().toLowerCase()).filter(validDnsLabel)
        .map((sub) => `${sub}.${domain}`)
      : [domain];
    for (const host of hosts) {
      if (!validDnsName(host) || seen.has(host)) continue;
      seen.add(host);
      const origin = normalizeBase(`https://${host}`);
      if (!origin) continue;
      items.push({ url: origin, host });
      if (items.length >= MIRROR_MAX) break outer;
    }
  }
  if (!items.length) throw new Error("发布脚本中没有合法镜像地址");
  return items;
}

/* ── 两个发布源合并与可信集合 ───────────────────────────── */

async function mirrorsFromPage(page: string): Promise<PublishedPage> {
  // 一个总时限覆盖 DNS、重定向、页面与脚本两个响应体以及解析
  const timer = deadline(PAGE_TIMEOUT_MS);
  try {
    const html = await getText(page, timer.signal);
    const script = scriptSrc(page, html);
    const js = await getText(script, timer.signal);
    return { source: page, script, items: parseMirrors(js) };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("获取地址发布页超时（8 秒）");
    }
    throw error;
  } finally {
    timer.cancel();
  }
}

function mergePublishers(results: PromiseSettledResult<PublishedPage>[], current: string): MirrorListing {
  const pages: PublishedPage[] = [];
  const errors: string[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") pages.push(result.value);
    else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push(`${PUBLISH_PAGES[index]}: ${reason}`);
    }
  });
  // 交错合并，避免第一个发布源的完整列表把第二个发布源挤掉
  const items: MirrorItem[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < MIRROR_MAX; index++) {
    for (const page of pages) {
      const item = page.items[index];
      if (!item || items.length >= MIRROR_MAX || seen.has(item.url)) continue;
      seen.add(item.url);
      items.push(item);
    }
  }
  if (!items.length) {
    throw new Error(errors.length ? errors.join("；") : "地址发布页里没有可用的镜像地址");
  }
  const recommended: MirrorItem[] = [];
  const recommendedSeen = new Set<string>();
  // 当前线路只作展示置顶，不代表它被发布页收录
  const currentBase = normalizeBase(current);
  if (currentBase) {
    recommendedSeen.add(currentBase);
    recommended.push({ url: currentBase, host: new URL(currentBase).hostname });
  }
  for (const item of items) {
    if (recommended.length >= RECOMMENDED_MAX) break;
    if (recommendedSeen.has(item.url)) continue;
    recommendedSeen.add(item.url);
    recommended.push(item);
  }
  const sources = pages.map((page) => page.source).join(", ");
  const scripts = pages.map((page) => page.script).join(", ");
  return { source: sources, script: scripts, items, recommended_source: sources, recommended, errors };
}

function rememberPublished(items: MirrorItem[]): void {
  for (const item of items) {
    if (trusted.has(item.url)) continue;
    if (trusted.size >= TRUST_MAX) {
      const oldest = trusted.values().next().value;
      if (oldest) trusted.delete(oldest);
    }
    trusted.add(item.url);
  }
}

/** 每次调用都重新抓发布页（用户点「刷新」时就是要用新列表） */
export async function loadMirrors(current: string): Promise<MirrorListing> {
  const results = await Promise.allSettled(PUBLISH_PAGES.map((page) => mirrorsFromPage(page)));
  const listing = mergePublishers(results, current);
  rememberPublished(listing.items);
  return listing;
}

/** 手动切换非固定线路时复核发布来源；发布页不可达则保持不信任 */
export async function verifyPublishedOrigin(origin: string, current: string): Promise<boolean> {
  if (isFixed(origin) || isTrustedMirror(origin)) return true;
  try { await loadMirrors(current); } catch { /* 保持不信任 */ }
  return isTrustedMirror(origin);
}

/** 自动选线候选：只取已发布且非固定线路的镜像，当前线路必须真的在发布列表里 */
export function autoCandidates(items: MirrorItem[], current: string): string[] {
  const published: string[] = [];
  for (const item of items) {
    const origin = normalizeBase(item.url);
    if (origin && !isFixed(origin) && isTrustedMirror(origin)) published.push(origin);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const currentBase = normalizeBase(current);
  if (currentBase && published.includes(currentBase)) {
    seen.add(currentBase);
    out.push(currentBase);
  }
  for (const origin of published) {
    if (out.length >= AUTO_MIRROR_MAX) break;
    if (seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}
