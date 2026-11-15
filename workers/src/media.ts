// H5 媒体代理：对齐 src-tauri/src/media.rs 的 /img、/hls、/seg。
// 封面可能需要 AES-CBC 解密；m3u8 的所有 URI（含子清单）都必须改回同源代理，
// 否则浏览器会直接请求上游 CDN，触发 CORS 与防盗链失败。
import { MEDIA_PREFIX, UA } from "./config";
import { fetchGuarded, parseTarget, text, type Env } from "./policy";

const IMG_KEY = new TextEncoder().encode("f5d965df75336270");
const IMG_IV = new TextEncoder().encode("97b60394abc2fbe1");

export type MediaRoute = "img" | "hls" | "seg";

function imageKind(bytes: Uint8Array<ArrayBuffer>): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e
    && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 4 && String.fromCharCode(...bytes.slice(0, 4)) === "GIF8") return "image/gif";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

async function decryptCover(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", IMG_KEY, { name: "AES-CBC" }, false, ["decrypt"]);
  // Web Crypto 的 AES-CBC 会自动去掉 PKCS#7 padding，无需 Rust 侧的 strip_padding
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv: IMG_IV }, key, bytes);
  return new Uint8Array(plain);
}

/* ── HLS 改写 ───────────────────────────────────────────── */

function enc(value: string): string { return encodeURIComponent(value); }
function absolutize(base: string, target: string): string {
  if (/^https?:\/\//i.test(target)) return target;
  try { return new URL(target, base).toString(); } catch { return target; }
}

/** 属性列表里引号内可能有逗号，不能直接按逗号切 */
function hlsAttributes(line: string): { tag: string; attributes: string[] } | null {
  const index = line.indexOf(":");
  if (index < 0) return null;
  const tag = line.slice(0, index);
  const rest = line.slice(index + 1);
  const attributes: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '"') quoted = !quoted;
    if (rest[i] === "," && !quoted) { attributes.push(rest.slice(start, i)); start = i + 1; }
  }
  attributes.push(rest.slice(start));
  return { tag, attributes };
}

function mapUriAttributes(line: string, rewrite: (uri: string) => string): string {
  const parsed = hlsAttributes(line);
  if (!parsed) return line;
  const mapped = parsed.attributes.map((attribute) => {
    const eq = attribute.indexOf("=");
    if (eq < 0) return attribute;
    const key = attribute.slice(0, eq);
    const value = attribute.slice(eq + 1).trim();
    if (key.trim() !== "URI" || !value.startsWith('"') || !value.endsWith('"')) return attribute;
    return `${key}="${rewrite(value.slice(1, -1))}"`;
  });
  return `${parsed.tag}:${mapped.join(",")}`;
}

const segUrl = (absolute: string): string => `${MEDIA_PREFIX}/seg?u=${enc(absolute)}`;

function rewritePlaylist(base: string, source: string): string {
  const body = source.replace(/^\u{feff}/u, "");
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trimEnd();
    if (!line) { out.push(""); continue; }
    if (line.startsWith("#")) {
      // 可派生 URL 的内容引导：直接丢弃，避免绕过目标校验
      if (line.startsWith("#EXT-X-CONTENT-STEERING:")) continue;
      if (line.startsWith("#EXT-X-DATERANGE:")) {
        const parsed = hlsAttributes(line);
        if (parsed) {
          const safe = parsed.attributes.filter((attribute) => {
            const key = attribute.split("=")[0].trim().toUpperCase();
            return !key.includes("URI") && key !== "X-ASSET-LIST";
          });
          out.push(`${parsed.tag}:${safe.join(",")}`);
        }
        continue;
      }
      if (line.includes('URI="')) {
        // KEY / MAP / MEDIA / SESSION-KEY / PART 等先把相对 URI 补绝对，再改写到 /seg
        const absolute = mapUriAttributes(line, (uri) => absolutize(base, uri));
        out.push(mapUriAttributes(absolute, (uri) => segUrl(uri)));
      } else {
        out.push(line);
      }
    } else {
      out.push(segUrl(absolutize(base, line)));
    }
  }
  return `${out.join("\n")}\n`;
}

/* ── 响应与缓存 ─────────────────────────────────────────── */

function respond(body: Uint8Array<ArrayBuffer> | string, contentType: string, cache: string, status = 200): Response {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return new Response(bytes, {
    status,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.length),
      "Accept-Ranges": "bytes",
      "Access-Control-Expose-Headers": "Content-Length, Content-Type, Accept-Ranges",
      "Cache-Control": cache,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** 封面与静态分片做边缘缓存，避免重复请求给上游加压；失败不影响取流 */
async function withCache(request: Request, produce: () => Promise<Response>, enabled: boolean): Promise<Response> {
  if (!enabled || request.method !== "GET") return produce();
  try {
    const cache = await caches.open("hghubx-h5-media");
    const hit = await cache.match(request);
    if (hit) return hit;
    const fresh = await produce();
    if (fresh.status === 200 && fresh.headers.get("cache-control")?.includes("max-age")) {
      await cache.put(request, fresh.clone());
    }
    return fresh;
  } catch {
    return produce();
  }
}

function upstreamHeaders(base: string): Record<string, string> {
  return { "Referer": `${base}/`, "User-Agent": UA, "Accept": "*/*" };
}

async function fetchBytes(base: string, target: string, range: string | null): Promise<Response> {
  const headers = upstreamHeaders(base);
  if (range) headers.Range = range;
  return fetchGuarded(target, { method: "GET", headers });
}

/* ── 入口 ───────────────────────────────────────────────── */

export async function handleMedia(
  request: Request, _env: Env, base: string, route: MediaRoute,
): Promise<Response> {
  const raw = new URL(request.url).searchParams.get("u");
  if (!raw) return text("missing u", 400);
  let target: string;
  try {
    target = parseTarget(decodeURIComponent(raw));
  } catch (error) {
    return text(error instanceof Error ? error.message : "目标地址无效", 400);
  }
  // 对齐 lib.rs：只转发无条件、单头的 GET Range；有 If-Range 时退回完整响应
  const range = request.method === "GET" && !request.headers.has("if-range")
    && (request.headers.get("range") ?? "").split(",").length === 1
    ? request.headers.get("range") : null;

  try {
    if (route === "img") {
      return await withCache(request, async () => {
        const upstream = await fetchBytes(base, target, null);
        if (!upstream.ok) return text(`上游返回 HTTP ${upstream.status}`, 502);
        let bytes = new Uint8Array(await upstream.arrayBuffer());
        if (!imageKind(bytes)) {
          try { bytes = await decryptCover(bytes); }
          catch { return text("封面解密失败", 502); }
        }
        return respond(bytes, imageKind(bytes) ?? "image/jpeg", "public, max-age=86400");
      }, true);
    }

    if (route === "hls") {
      const upstream = await fetchBytes(base, target, null);
      if (!upstream.ok) return text(`上游返回 HTTP ${upstream.status}`, 502);
      const source = await upstream.text();
      if (!source.replace(/^\u{feff}/u, "").startsWith("#EXTM3U")) {
        return text("响应不是 HLS 播放列表", 502);
      }
      return respond(rewritePlaylist(target, source), "application/vnd.apple.mpegurl", "no-store");
    }

    // /seg：子清单需要继续改写，普通分片/密钥流式透传以控制内存
    const cacheable = !range;
    return await withCache(request, async () => {
      const upstream = await fetchBytes(base, target, range);
      if (!upstream.ok && upstream.status !== 206) return text(`上游返回 HTTP ${upstream.status}`, 502);
      const contentType = upstream.headers.get("content-type") ?? "";
      const playlist = /mpegurl/i.test(contentType)
        || /\.m3u8(\?|$)/i.test(target)
        || /^#EXTM3U/.test(contentType);
      if (playlist) {
        const source = await upstream.text();
        if (!source.replace(/^\u{feff}/u, "").startsWith("#EXTM3U")) {
          return text("响应不是 HLS 播放列表", 502);
        }
        return respond(rewritePlaylist(target, source), "application/vnd.apple.mpegurl", "no-store");
      }
      const headers = new Headers();
      headers.set("Content-Type", contentType || guessMime(target));
      headers.set("Cache-Control", upstream.status === 206 ? "no-store" : "public, max-age=3600");
      headers.set("Accept-Ranges", "bytes");
      headers.set("X-Content-Type-Options", "nosniff");
      for (const key of ["content-length", "content-range", "etag", "last-modified"]) {
        const value = upstream.headers.get(key);
        if (value) headers.set(key, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers });
    }, cacheable);
  } catch (error) {
    return text(error instanceof Error ? error.message : "媒体代理失败", 502);
  }
}

function guessMime(target: string): string {
  const path = target.split("?")[0].toLowerCase();
  if (path.endsWith(".ts")) return "video/mp2t";
  if (path.endsWith(".m4s") || path.endsWith(".mp4")) return "video/mp4";
  if (path.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  return "application/octet-stream";
}
