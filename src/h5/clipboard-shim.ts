/** H5 渠道的剪贴板兼容层，优先走 Clipboard API，失败时退回 execCommand。 */
export async function writeText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
  document.body.appendChild(field);
  field.select();
  try {
    if (!document.execCommand("copy")) throw new Error("浏览器拒绝复制");
  } finally {
    document.body.removeChild(field);
  }
}
