export type ExtensionType = "overlay" | "component" | "panel";

export interface ChannelExtension {
  id: string;
  name: string;
  description: string;
  icon: string;
  version: string;
  type: ExtensionType;
  slot: string;
  viewerUrl: string;
  height: number | null;
  targetHeight: number | null;
  aspectRatio: number | null;
}

const ttl = 5 * 60 * 1000;
const cache = new Map<string, { at: number; data: ChannelExtension[] }>();
const pending = new Map<string, Promise<ChannelExtension[]>>();

function normalizeExtension(value: unknown): ChannelExtension | null {
  if (!value || typeof value !== "object") return null;
  const extension = value as Record<string, unknown>;
  const id = typeof extension.id === "string" ? extension.id : "";
  const name = typeof extension.name === "string" ? extension.name : "";
  const viewerUrl =
    typeof extension.viewerUrl === "string" ? extension.viewerUrl : "";
  const type = extension.type;
  if (
    !/^[a-z0-9]{10,40}$/i.test(id) ||
    !name ||
    !/^https:\/\//.test(viewerUrl) ||
    (type !== "overlay" && type !== "component" && type !== "panel")
  )
    return null;
  const numberOrNull = (value: unknown): number | null | undefined =>
    value === null
      ? null
      : typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
  const height = numberOrNull(extension.height);
  const targetHeight = numberOrNull(extension.targetHeight);
  const aspectRatio = numberOrNull(extension.aspectRatio);
  if (
    height === undefined ||
    targetHeight === undefined ||
    aspectRatio === undefined
  )
    return null;
  const icon =
    typeof extension.icon === "string" && /^https:\/\//.test(extension.icon)
      ? extension.icon
      : "";
  return {
    id,
    name,
    description:
      typeof extension.description === "string" ? extension.description : "",
    icon,
    version: typeof extension.version === "string" ? extension.version : "",
    type,
    slot: typeof extension.slot === "string" ? extension.slot : "",
    viewerUrl,
    height,
    targetHeight,
    aspectRatio,
  };
}

export async function channelExtensions(
  login: string,
): Promise<ChannelExtension[]> {
  const key = login.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < ttl) return cached.data.slice();
  const inflight = pending.get(key);
  if (inflight) return (await inflight).slice();
  const request = fetch("/api/extensions?channel=" + encodeURIComponent(key), {
    signal: AbortSignal.timeout(10000),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error("EXTENSIONS_UNAVAILABLE");
      const payload = (await response.json()) as {
        channel?: unknown;
        extensions?: unknown;
      };
      const channel =
        typeof payload?.channel === "string"
          ? payload.channel.toLowerCase()
          : "";
      if (channel !== key) throw new Error("EXTENSIONS_UNAVAILABLE");
      const list = Array.isArray(payload?.extensions)
        ? payload.extensions
            .map(normalizeExtension)
            .filter(
              (extension): extension is ChannelExtension => extension !== null,
            )
        : [];
      if (cache.size >= 200) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { at: Date.now(), data: list });
      return list;
    })
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return (await request).slice();
}

export function extensionPopoutUrl(
  login: string,
  extension: ChannelExtension,
): string {
  const view =
    extension.type === "overlay"
      ? "video_overlay"
      : extension.type === "component"
        ? "component"
        : "panel";
  return (
    "https://www.twitch.tv/popout/" +
    encodeURIComponent(login) +
    "/extensions/" +
    encodeURIComponent(extension.id) +
    "/" +
    view
  );
}
