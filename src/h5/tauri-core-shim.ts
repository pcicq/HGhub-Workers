/**
 * H5 渠道的 @tauri-apps/api/core 兼容层。
 * 保持上游源码里的 invoke / addPluginListener 调用不变，运行期统一落到 H5 网关。
 */
import { invokeCompat } from "../transport";

export const invoke = <T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> => invokeCompat<T>(cmd, args);

/** 原生插件事件在浏览器里没有宿主，注册成功但永不触发。 */
export function addPluginListener(
  _plugin: string,
  _event: string,
  _handler: (payload?: unknown) => void,
): Promise<{ unregister: () => Promise<void> }> {
  return Promise.resolve({ unregister: async () => {} });
}

export const isTauri = (): boolean => false;
