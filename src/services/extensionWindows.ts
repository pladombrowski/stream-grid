import { extensionPopoutUrl, type ChannelExtension } from "./extensions";
import { extensionWindowBox } from "./extensionWindowGeometry";

const windows = new Map<string, Window>();
const tabId = Math.random().toString(36).slice(2, 10);

function screenBounds() {
  // availLeft/availTop are non-standard and missing from the DOM types.
  const display = screen as Screen & { availLeft?: number; availTop?: number };
  const left =
    typeof display.availLeft === "number" && Number.isFinite(display.availLeft)
      ? display.availLeft
      : window.screenX;
  const top =
    typeof display.availTop === "number" && Number.isFinite(display.availTop)
      ? display.availTop
      : window.screenY;
  return {
    left,
    top,
    right: left + screen.availWidth,
    bottom: top + screen.availHeight,
  };
}

function key(login: string, extension: ChannelExtension) {
  return login + ":" + extension.id;
}

export function openExtensionWindow(
  login: string,
  extension: ChannelExtension,
  anchor: HTMLElement,
): boolean {
  const channel = login.toLowerCase();
  const id = key(channel, extension);
  const existing = windows.get(id);
  if (existing && !existing.closed) {
    existing.focus();
    return true;
  }
  const box = extensionWindowBox(
    extension,
    anchor.getBoundingClientRect(),
    screenBounds(),
    {
      screenX: window.screenX,
      screenY: window.screenY,
      chrome: window.outerHeight - window.innerHeight,
    },
  );
  const features =
    "popup=yes,width=" +
    box.width +
    ",height=" +
    box.height +
    ",left=" +
    box.left +
    ",top=" +
    box.top +
    ",resizable=yes,scrollbars=no";
  const popup = window.open(
    extensionPopoutUrl(channel, extension),
    "tg-ext-" + tabId + "-" + channel + "-" + extension.id,
    features,
  );
  if (!popup) return false;
  try {
    popup.opener = null;
  } catch {
    try {
      popup.close();
    } catch {
      /* The window is unusable either way; the caller shows the popup notice. */
    }
    return false;
  }
  windows.set(id, popup);
  popup.focus();
  return true;
}

export function closeExtensionWindows(login?: string) {
  const channel = login?.toLowerCase();
  for (const [id, popup] of windows) {
    if (channel !== undefined && !id.startsWith(channel + ":")) continue;
    if (!popup.closed) popup.close();
    windows.delete(id);
  }
}
