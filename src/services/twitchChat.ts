import { tr } from "./preferences";

// Twitch's chat iframe keeps its own login in Twitch's browser cookies. When a
// browser blocks or partitions those cookies, the popup says the login worked
// but the iframe reloads logged out. A Stream Grid session already carries a
// Twitch user token, so the same login can read and send chat over Twitch's IRC
// gateway without touching third-party cookies.
export type TwitchChatStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed";

export interface TwitchChatEmote {
  id: string;
  ranges: [number, number][];
}

export interface TwitchChatMessage {
  id: string;
  login: string;
  displayName: string;
  color: string;
  text: string;
  action: boolean;
  emotes: TwitchChatEmote[];
  sentAt: number;
}

export interface TwitchChatNotice {
  text: string;
  error: boolean;
}

export type TwitchChatEvent =
  | { type: "message"; message: TwitchChatMessage }
  | { type: "notice"; notice: TwitchChatNotice };

export interface TwitchChatOptions {
  channel: string;
  login: string;
  token: () => string;
  refresh: () => Promise<boolean>;
  onEvent: (event: TwitchChatEvent) => void;
  onStatus: (status: TwitchChatStatus) => void;
}

export interface IrcLine {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
  trailing: string;
}

const COLORS = [
  "#ff7f50",
  "#9acd32",
  "#00b5ad",
  "#ff69b4",
  "#5c6bc0",
  "#b45f06",
  "#2e8b57",
  "#d2691e",
  "#7b68ee",
  "#008b8b",
  "#c71585",
];

function unescapeTag(value: string) {
  return value.replace(/\\([s:r\\n])/g, (_, code: string) => {
    switch (code) {
      case "s":
        return " ";
      case ":":
        return ";";
      case "r":
        return "\r";
      case "n":
        return "\n";
      default:
        return "\\";
    }
  });
}

export function parseTags(raw: string) {
  const tags: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    tags[part.slice(0, separator)] = unescapeTag(
      part.slice(separator + 1),
    );
  }
  return tags;
}

export function parseIrcLine(line: string): IrcLine | null {
  let rest = line.replace(/[\r\n]+$/, "");
  if (!rest) return null;
  let tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    tags = parseTags(rest.slice(1, end));
    rest = rest.slice(end + 1);
  }
  let prefix = "";
  if (rest.startsWith(":")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }
  let trailing = "";
  const trailingAt = rest.indexOf(" :");
  if (trailingAt >= 0) {
    trailing = rest.slice(trailingAt + 2);
    rest = rest.slice(0, trailingAt);
  }
  const parts = rest.split(" ").filter(Boolean);
  const command = parts.shift() || "";
  return { tags, prefix, command, params: parts, trailing };
}

function colorFor(login: string) {
  let hash = 0;
  for (const char of login) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

export function emoteUrl(id: string, dark: boolean) {
  // Twitch serves legacy numeric ids and the newer `emotesv2_…` ids from the
  // same CDN path.
  if (!/^(?:\d+|emotesv2_[a-z0-9]+)$/i.test(id)) return "";
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/${dark ? "dark" : "light"}/1.0`;
}

function emotes(tags: Record<string, string>) {
  return (tags.emotes || "")
    .split("/")
    .filter(Boolean)
    .map((value) => {
      const [id, ranges = ""] = value.split(":");
      const parsed: [number, number][] = [];
      for (const range of ranges.split(",")) {
        const [start, end] = range.split("-").map(Number);
        if (
          Number.isInteger(start) &&
          Number.isInteger(end) &&
          start >= 0 &&
          end >= start
        )
          parsed.push([start, end]);
      }
      return { id, ranges: parsed };
    })
    .filter((emote) => emote.ranges.length > 0);
}

export function parsePrivmsg(line: IrcLine): TwitchChatMessage | null {
  if (line.command !== "PRIVMSG" || !line.trailing) return null;
  const login = (line.prefix.split("!")[0] || "").toLowerCase();
  if (!login) return null;
  let text = line.trailing;
  const action = text.startsWith("\u0001ACTION ") && text.endsWith("\u0001");
  if (action) text = text.slice(8, -1);
  const rawColor = line.tags.color || "";
  const sentAt = Number(line.tags["tmi-sent-ts"]) || Date.now();
  return {
    id: line.tags.id || `${sentAt}-${login}`,
    login,
    displayName: line.tags["display-name"] || login,
    color: /^#[0-9a-f]{6}$/i.test(rawColor) ? rawColor : colorFor(login),
    text,
    action,
    emotes: emotes(line.tags),
    sentAt,
  };
}

export class TwitchChatClient {
  private options: TwitchChatOptions;
  private socket: WebSocket | null = null;
  private reconnectTimer: number | undefined;
  private closed = false;
  private attempts = 0;
  private generation = 0;
  private tokenRetried = false;
  private status: TwitchChatStatus = "connecting";

  constructor(options: TwitchChatOptions) {
    this.options = options;
  }

  start() {
    this.closed = false;
    this.attempts = 0;
    this.tokenRetried = false;
    this.open();
  }

  stop() {
    this.closed = true;
    this.generation++;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }

  retry() {
    if (this.closed) return;
    this.attempts = 0;
    this.tokenRetried = false;
    this.open();
  }

  send(text: string) {
    const message = text.replace(/[\r\n]+/g, " ").trim().slice(0, 500);
    if (!message || this.status !== "connected") return false;
    this.raw(`PRIVMSG #${this.options.channel} :${message}`);
    return true;
  }

  private setStatus(status: TwitchChatStatus) {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus(status);
  }

  private raw(line: string) {
    this.socket?.send(line + "\r\n");
  }

  private open() {
    if (this.closed) return;
    clearTimeout(this.reconnectTimer);
    const generation = ++this.generation;
    this.socket?.close();
    this.setStatus(this.attempts ? "reconnecting" : "connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.closed || generation !== this.generation) return;
      const token = this.options.token();
      if (!token) {
        this.fail();
        return;
      }
      this.raw("CAP REQ :twitch.tv/tags twitch.tv/commands");
      this.raw(`PASS oauth:${token}`);
      this.raw(`NICK ${this.options.login}`);
      this.raw(`JOIN #${this.options.channel}`);
    });
    socket.addEventListener("message", (event) => {
      if (this.closed || generation !== this.generation) return;
      for (const line of String(event.data).split("\r\n")) {
        if (line) this.handle(line);
      }
    });
    socket.addEventListener("close", () => {
      if (this.closed || generation !== this.generation) return;
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (this.closed || generation !== this.generation) return;
      this.scheduleReconnect();
    });
  }

  private handle(line: string) {
    const parsed = parseIrcLine(line);
    if (!parsed) return;
    switch (parsed.command) {
      case "PING":
        this.raw(`PONG :${parsed.trailing || "tmi.twitch.tv"}`);
        return;
      case "001":
        this.attempts = 0;
        this.tokenRetried = false;
        this.setStatus("connected");
        return;
      case "PRIVMSG": {
        const message = parsePrivmsg(parsed);
        if (message) this.options.onEvent({ type: "message", message });
        return;
      }
      case "USERNOTICE": {
        const text = parsed.tags["system-msg"];
        if (text)
          this.options.onEvent({
            type: "notice",
            notice: { text, error: false },
          });
        return;
      }
      case "NOTICE": {
        if (/login authentication failed/i.test(parsed.trailing)) {
          void this.refreshLogin();
          return;
        }
        if (parsed.trailing)
          this.options.onEvent({
            type: "notice",
            notice: {
              text: parsed.trailing,
              error: /error|failed|not sent/i.test(parsed.trailing),
            },
          });
        return;
      }
      case "RECONNECT":
        this.socket?.close();
        return;
    }
  }

  private async refreshLogin() {
    if (this.tokenRetried || this.closed) {
      this.fail();
      return;
    }
    this.tokenRetried = true;
    this.generation++;
    this.socket?.close();
    this.socket = null;
    this.setStatus("reconnecting");
    const refreshed = await this.options.refresh();
    if (this.closed) return;
    if (!refreshed || !this.options.token()) {
      this.fail();
      return;
    }
    this.open();
  }

  private fail() {
    this.setStatus("failed");
    this.options.onEvent({
      type: "notice",
      notice: { text: tr("Impossible de se connecter au chat."), error: true },
    });
  }

  private scheduleReconnect() {
    if (this.closed) return;
    this.setStatus("reconnecting");
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5));
    this.reconnectTimer = window.setTimeout(() => this.open(), delay);
  }
}
