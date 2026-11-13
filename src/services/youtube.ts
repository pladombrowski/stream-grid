import type { Channel } from "../types/domain";
import { HttpError, isYouTubeKey, numberFormat, validLogin } from "./library";
import { tr } from "./preferences";

const videoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const channelIdPattern = /^UC[A-Za-z0-9_-]{22}$/;
const handlePattern = /^@[A-Za-z0-9._-]{3,60}$/;
const youtubeHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

export interface YouTubeLive {
  live: boolean;
  videoId: string;
  title: string;
  author: string;
  thumbnail: string;
  viewers: number;
  startedAt: number;
}

function isYouTubeUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    youtubeHosts.has(url.hostname.toLowerCase())
  );
}

// A bare 11-character ID is also a valid Twitch login. Keep Twitch search for
// those ambiguous strings; a YouTube URL, youtu.be link, @handle, channel ID or
// an ID containing a dash or uppercase letter is unambiguous.
export function isYouTubeQuery(value: string) {
  const raw = value.trim();
  if (videoIdPattern.test(raw)) return !validLogin(raw);
  return (
    handlePattern.test(raw) || channelIdPattern.test(raw) || isYouTubeUrl(raw)
  );
}

function youtubeChannel(data: YouTubeLive): Channel {
  const videoId = data.videoId;
  const thumbnail = /^https:\/\//.test(data.thumbnail) ? data.thumbnail : "";
  return {
    twitch: "yt:" + videoId,
    platform: "youtube",
    youtubeId: videoId,
    display: data.author || data.title || "YouTube",
    profileUrl: thumbnail || "favicon.svg",
    previewUrl: thumbnail,
    offlineUrl: "",
    online: data.live,
    game: "YouTube",
    title: data.title,
    startedAt: data.startedAt,
    viewersAmount: {
      number: data.viewers,
      formatted: data.viewers > 0 ? numberFormat.format(data.viewers) : "",
    },
  };
}

export function restoreYouTubeChannel(data: Partial<Channel>): Channel | null {
  // The saved key is the source of truth: the grid looks tiles up by it, so a
  // corrupt youtubeId must never produce a second, unreachable key.
  const key = typeof data.twitch === "string" ? data.twitch : "";
  const savedVideoId =
    typeof data.youtubeId === "string" && videoIdPattern.test(data.youtubeId)
      ? data.youtubeId
      : "";
  const videoId = isYouTubeKey(key) ? key.slice(3) : savedVideoId;
  if (!videoId) return null;
  return {
    twitch: "yt:" + videoId,
    platform: "youtube",
    youtubeId: videoId,
    display: data.display || data.title || "YouTube",
    profileUrl: /^https:\/\//.test(data.profileUrl || "")
      ? data.profileUrl!
      : "favicon.svg",
    previewUrl: /^https:\/\//.test(data.previewUrl || "")
      ? data.previewUrl!
      : "",
    offlineUrl: /^https:\/\//.test(data.offlineUrl || "")
      ? data.offlineUrl!
      : "",
    online: data.online ?? null,
    game: data.game || "YouTube",
    title: data.title || "",
    startedAt: data.startedAt || 0,
    viewersAmount:
      data.viewersAmount && typeof data.viewersAmount.number === "number"
        ? { ...data.viewersAmount }
        : { number: 0, formatted: "" },
  };
}

export async function youtubeLive(
  query: string,
  signal?: AbortSignal,
): Promise<Channel | null> {
  const response = await fetch("/api/youtube?q=" + encodeURIComponent(query), {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
      : AbortSignal.timeout(12000),
  });
  if (response.status === 400) return null;
  if (!response.ok) {
    const error = new HttpError(
      response.status === 429
        ? tr("Trop de recherches. Réessaie dans une minute.")
        : tr("La recherche YouTube est indisponible pour le moment."),
    );
    error.status = response.status;
    throw error;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object") return null;
  const data = body as Partial<YouTubeLive>;
  if (
    data.live !== true ||
    typeof data.videoId !== "string" ||
    !videoIdPattern.test(data.videoId)
  )
    return null;
  return youtubeChannel({
    live: true,
    videoId: data.videoId,
    title: typeof data.title === "string" ? data.title : "",
    author: typeof data.author === "string" ? data.author : "",
    thumbnail: typeof data.thumbnail === "string" ? data.thumbnail : "",
    viewers: Number.isFinite(data.viewers) ? Number(data.viewers) : 0,
    startedAt: Number.isFinite(data.startedAt) ? Number(data.startedAt) : 0,
  });
}

export function youtubeWatchUrl(videoId: string) {
  return "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId);
}

export function youtubeChatUrl(videoId: string, dark: boolean) {
  const params = new URLSearchParams({
    v: videoId,
    embed_domain: location.hostname,
  });
  if (dark) params.set("dark_theme", "1");
  return "https://www.youtube.com/live_chat?" + params;
}
