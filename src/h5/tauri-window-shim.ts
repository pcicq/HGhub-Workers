/**
 * H5 渠道的 @tauri-apps/api/window 兼容层。
 * 桌面壳在浏览器里只作为布局容器：所有原生窗口能力降级为空操作。
 */
type Listener = () => void;
const resolved = () => Promise.resolve();

export function getCurrentWindow() {
  return {
    isMaximized: async () => false,
    isFullscreen: async () => false,
    onResized: (_listener: Listener) => Promise.resolve<() => void>(() => {}),
    toggleMaximize: resolved,
    minimize: resolved,
    close: resolved,
    setFullscreen: (_fullscreen: boolean) => resolved(),
    setTitleBarTheme: (_theme: unknown) => resolved(),
    startResizeDragging: (_direction: string) => resolved(),
  };
}
