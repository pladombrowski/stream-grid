import type { ChannelExtension } from "./extensions";

export interface ExtensionWindowRect {
  width: number;
  height: number;
  left: number;
  top: number;
  bottom: number;
}

export interface ExtensionWindowBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ExtensionWindowViewport {
  screenX: number;
  screenY: number;
  chrome: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function extensionWindowBox(
  extension: ChannelExtension,
  rect: ExtensionWindowRect,
  bounds: ExtensionWindowBounds,
  viewport: ExtensionWindowViewport,
) {
  const chrome = Math.max(0, viewport.chrome);
  let width: number, height: number, left: number;
  let top = 0; // panels are positioned once the final height is known
  if (extension.type === "overlay") {
    width = clamp(rect.width * 0.33, 300, 420);
    height = clamp(rect.height, 300, 820);
    left = viewport.screenX + rect.left;
    top = viewport.screenY + chrome + rect.top;
  } else if (extension.type === "component") {
    const target = clamp((extension.targetHeight ?? 7000) / 10000, 0.2, 0.95);
    height = clamp(rect.height * target, 180, 620);
    width = clamp(height * (extension.aspectRatio || 4 / 3), 220, 620);
    left = viewport.screenX + rect.left + 16;
    top = viewport.screenY + chrome + rect.top + 16;
  } else {
    width = clamp(rect.width, 320, 520);
    // The companion window stays compact and is resizable, so a taller panel can be resized by the viewer.
    height = clamp(extension.height || 150, 120, 300);
    left = viewport.screenX + rect.left;
  }
  width = Math.round(Math.min(width, bounds.right - bounds.left));
  height = Math.round(Math.min(height, bounds.bottom - bounds.top));
  if (extension.type === "panel")
    top = viewport.screenY + chrome + rect.bottom - height;
  left = Math.round(clamp(left, bounds.left, bounds.right - width));
  top = Math.round(clamp(top, bounds.top, bounds.bottom - height));
  return { width, height, left, top };
}
