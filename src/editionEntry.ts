// 构建期入口：H5 仓库固定解析到 src/main.tsx；alias 保留是为了与上游结构兼容。
// 先同步装配旧版 WebView 垫片，再在同一入口 chunk 内直接装载对应版本，避免额外动态分包瀑布流。
import "./legacyRuntime";
import "@edition-bootstrap";
