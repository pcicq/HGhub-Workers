import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import StartupGate from "./components/LaunchAnimation";
import { AppProvider } from "./store";
import { invokeCompat, isH5, probeH5 } from "./transport";
import "./index.css";
import { initPlaybackLog, installPlaybackPageEvents, tracePlayback } from "./playbackDiagnostics";
import { initAutoLine } from "./autoLine";
import { APP_VERSION, LOCAL, logLine, platform, webviewVersion } from "./api";
import Hls from "hls.js";
import { installLayoutDiagnostics } from "./layoutDiagnostics";
installPlaybackPageEvents();
void initPlaybackLog();
/* 环境指纹：写进始终记录的 debug.log。用户复制诊断时不用再自报版本、平台、内核版本 */
logLine(
  `[env] ver=${APP_VERSION} channel=${isH5 ? "h5" : "tauri"} platform=${platform} webview=${webviewVersion} ` +
    `engine=${Hls.isSupported() ? "hls.js" : "native"} ` +
    `mss=${"MediaSource" in window ? "y" : "n"} media=${LOCAL} ` +
    `screen=${screen.width}x${screen.height} dpr=${devicePixelRatio} lang=${navigator.language}`,
);

/* 环境指纹也进结构化日志（开诊断后不会只有一行空跑） */
tracePlayback("app.env", {
  ver: APP_VERSION, platform, webview: webviewVersion,
  engine: Hls.isSupported() ? "hls.js" : "native",
  media_source: "MediaSource" in window, managed_media_source: "ManagedMediaSource" in window,
  media_scheme: LOCAL.split(":")[0], screen: `${screen.width}x${screen.height}`,
  dpr: devicePixelRatio, lang: navigator.language,
});
/* 运行期错误统一落到 debug.log，便于自查 */
function report(kind: string, msg: string) {
  invokeCompat("debug_log", { msg: `[${kind}] ${msg}` }).catch(() => {});
  tracePlayback(`app.${kind}`, { detail: msg });
}
window.addEventListener("error", (e) => {
  report("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  report("reject", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
});

/* iOS 底部留白：改用 CSS 100dvh（见 index.css）动态跟踪可视高度。
   不再用 JS 在启动时钉死 html 高度——启动瞬间 visualViewport.height 尚未
   完成布局，抓到错误值会把 html 高度锁死，正是「底部留白、旋转一次才恢复」的根因。 */

/** H5 网关探针失败时给出可见提示，避免只留下空白页面 */
function showH5Error(message: string) {
  console.error("[h5]", message);
  const box = document.createElement("div");
  box.setAttribute("role", "alert");
  box.style.cssText = "position:fixed;z-index:9999;left:50%;top:16px;transform:translateX(-50%);" +
    "max-width:min(92vw,520px);padding:12px 16px;border-radius:12px;background:#2a1416;color:#ffd9d9;" +
    "border:1px solid #6b2b2b;font:13px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;" +
    "box-shadow:0 8px 30px rgba(0,0,0,.4)";
  box.textContent = `H5 渠道不可用：${message}`;
  document.body.appendChild(box);
}

if (isH5) void probeH5().catch((error: unknown) => showH5Error(String(error)));

/** Account restore, line probes and content requests begin only after agreement. */
function AcceptedApplication() {
  React.useEffect(() => { initAutoLine(); }, []);
  return <AppProvider><App /></AppProvider>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StartupGate><AcceptedApplication /></StartupGate>
  </React.StrictMode>,
);
installLayoutDiagnostics();
