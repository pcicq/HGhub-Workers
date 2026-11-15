/**
 * H5 渠道契约校验：
 *   1. 前端所有 invoke 命令都必须在 Worker 命令表或前端本地拦截表中；
 *   2. 两端的协议版本、媒体前缀、上游固定线路必须一致。
 * 任何一项不一致直接 exit 1，避免「页面能开但某个按钮静默失效」。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };

function walk(dir) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    const path = join(dir, name);
    const full = join(root, path);
    if (statSync(full).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/* ── 1. 命令覆盖 ─────────────────────────────────────────── */

// 只从 call / invokeCompat / invoke 调用的第一个参数取命令名，
// 避免把 activity.pause("proxy_restore")、setTab("home") 之类当成命令。
const CALL_RE = /\b(?:call|invokeCompat|invoke)\b/g;
const ARG_RE = /^[\s\S]{0,600}?\(\s*"([a-z0-9_:|]+)"/;
const COMMAND_NAME = /^(api_|line_|proxy_|playback_log_|set_|plugin:|app_boot$|security_set$|net_diag$|cache_clear$|check_update$|open_url$|debug_log$)/;
const used = new Set();
for (const file of walk("src")) {
  const source = read(file);
  for (const match of source.matchAll(CALL_RE)) {
    const tail = source.slice(match.index + match[0].length);
    const arg = ARG_RE.exec(tail)?.[1];
    if (arg && COMMAND_NAME.test(arg)) used.add(arg);
  }
}

const KEY_RE = /^\s*"([a-z0-9_:|]+)":/gm;
function block(source, startMark, endMark) {
  const start = source.indexOf(startMark);
  const end = source.indexOf(endMark);
  return start >= 0 && end > start ? source.slice(start, end) : "";
}

const rpcSource = read("workers/src/rpc.ts");
const commandBlock = block(rpcSource, "__RPC_COMMANDS_START__", "__RPC_COMMANDS_END__");
check(!!commandBlock, "workers/src/rpc.ts 缺少 __RPC_COMMANDS_START__/END__ 标记");
const serverCommands = new Set([...commandBlock.matchAll(KEY_RE)].map((m) => m[1]));

const transportSource = read("src/transport.ts");
const localStart = transportSource.indexOf("export const LOCAL_COMMANDS");
const localEnd = localStart >= 0 ? transportSource.indexOf("\n};", localStart) : -1;
const localBlock = localStart >= 0 && localEnd > localStart
  ? transportSource.slice(localStart, localEnd) : "";
check(!!localBlock, "src/transport.ts 缺少 LOCAL_COMMANDS 表");
const localCommands = new Set([...localBlock.matchAll(KEY_RE)].map((m) => m[1]));

const missing = [...used].filter((cmd) => !serverCommands.has(cmd) && !localCommands.has(cmd)).sort();
check(missing.length === 0, `前端命令没有对应实现：${missing.join(", ")}`);

// 版本探针与媒体前缀是双向契约，任一侧漂移都会让 H5 静默失效
const frontContract = /const API_CONTRACT = (\d+);/.exec(transportSource)?.[1];
const workerConfig = read("workers/src/config.ts");
const serverContract = /export const API_CONTRACT = (\d+);/.exec(workerConfig)?.[1];
check(!!frontContract && frontContract === serverContract,
  `API_CONTRACT 不一致：前端 ${frontContract ?? "缺失"} / Worker ${serverContract ?? "缺失"}`);

const prefix = /export const MEDIA_PREFIX = "([^"]+)";/.exec(workerConfig)?.[1];
const frontPrefix = /export const H5_MEDIA = "([^"]+)";/.exec(transportSource)?.[1];
const apiLocal = /export const LOCAL = isH5\s*\?\s*"([^"]+)"/.exec(read("src/api.ts"))?.[1];
check(!!prefix && prefix === frontPrefix && prefix === apiLocal,
  `媒体前缀不一致：Worker ${prefix ?? "缺失"} / transport ${frontPrefix ?? "缺失"} / api.ts ${apiLocal ?? "缺失"}`);

// 固定线路必须与 Rust 侧同源，上游改了线路这里要能立刻发现
const lines = /export const FIXED_LINES = \[([\s\S]*?)\n\];/.exec(workerConfig)?.[1] ?? "";
const bases = [...lines.matchAll(/url:\s*"([^"]+)"/g)].map((m) => m[1]);
const rust = read("src-tauri/src/net.rs") + read("src-tauri/src/lines.rs");
check(bases.length >= 2, "Worker 的固定线路表为空");
for (const base of bases) check(rust.includes(base), `固定线路 ${base} 在 Rust 侧不存在`);

check(/import pkg from "\.\.\/\.\.\/package\.json"/.test(workerConfig)
  && /APP_VERSION: string = pkg\.version/.test(workerConfig),
  "Worker 版本必须直接取根 package.json，不能写死");

/* ── 结果 ───────────────────────────────────────────────── */

if (problems.length) {
  console.error(`H5 契约校验失败（${problems.length} 项）：`);
  for (const item of problems) console.error(`  - ${item}`);
  process.exit(1);
}
console.log(`H5 契约校验通过：前端 ${used.size} 个命令 · Worker ${serverCommands.size} 个 · 本地拦截 ${localCommands.size} 个`);
console.log(`协议版本 ${serverContract} · 媒体前缀 ${prefix} · 固定线路 ${bases.join(", ")}`);
