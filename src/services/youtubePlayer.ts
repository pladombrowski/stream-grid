import type {
  PlayerConstructor,
  TwitchPlayer,
  YouTubePlayerInstance,
} from "../types/player";

type Options = ConstructorParameters<PlayerConstructor>[1];

const STATES = {
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
} as const;

let api: Promise<void> | null = null;

function loadAPI() {
  if (window.YT?.Player) return Promise.resolve();
  if (api) return api;
  api = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      api = null;
      reject(new Error("YOUTUBE_UNAVAILABLE"));
    }, 12000);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      window.clearTimeout(timer);
      resolve();
    };
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://www.youtube.com/iframe_api"]',
    );
    if (existing) return;
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => {
      window.clearTimeout(timer);
      api = null;
      script.remove();
      reject(new Error("YOUTUBE_UNAVAILABLE"));
    };
    document.head.append(script);
  });
  return api;
}

// YouTube's official player behind the same interface as Twitch's embed. The
// workspace keeps ownership of pause, mute, volume and spotlight; YouTube keeps
// its own controls, quality and latency handling.
export class YouTubePlayer implements TwitchPlayer {
  static READY = "ready";
  static PLAYING = "playing";
  private element: HTMLElement;
  private videoId: string;
  private listeners = new Map<string, (() => void)[]>();
  private player: YouTubePlayerInstance | null = null;
  private target = document.createElement("div");
  private destroyed = false;
  private ready = false;
  private failed = false;
  private state = -1;
  private muted: boolean;
  private volume = 1;
  private wantPlay = false;
  private bufferingFromPlaying = false;

  constructor(element: HTMLElement, options: Options) {
    this.element = element;
    this.videoId = options.videoId || "";
    this.muted = options.muted;
    this.wantPlay = options.autoplay;
    this.target.style.width = "100%";
    this.target.style.height = "100%";
    element.append(this.target);
    // The listeners are attached by the caller right after construction.
    queueMicrotask(() => void this.load());
  }

  private async load() {
    if (!this.videoId) {
      this.fail();
      return;
    }
    try {
      await loadAPI();
    } catch {
      this.fail();
      return;
    }
    if (this.destroyed) return;
    const YT = window.YT;
    if (!YT?.Player) {
      this.fail();
      return;
    }
    try {
      this.player = new YT.Player(this.target, {
        videoId: this.videoId,
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 0,
          controls: 1, // YouTube's own chrome; the tile header drives play and sound too
          disablekb: 1,
          enablejsapi: 1,
          fs: 1,
          playsinline: 1,
          rel: 0,
          origin: location.origin,
          hl: document.documentElement.lang || "en",
        },
        events: {
          onReady: () => {
            if (this.destroyed || !this.player) return;
            this.ready = true;
            this.state = this.player.getPlayerState();
            this.player.setVolume(this.volume * 100);
            if (this.muted) this.player.mute();
            else this.player.unMute();
            this.emit("ready");
            if (this.wantPlay) this.play();
          },
          onStateChange: (event) => {
            if (this.destroyed) return;
            const previous = this.state;
            this.state = event.data;
            if (event.data === STATES.PLAYING) {
              const commanded = this.wantPlay;
              this.wantPlay = false;
              const recovered =
                !commanded &&
                previous === STATES.BUFFERING &&
                this.bufferingFromPlaying;
              const duplicate = !commanded && previous === STATES.PLAYING;
              this.bufferingFromPlaying = false;
              if (!recovered && !duplicate) this.emit("play");
              this.emit("playing");
            } else if (event.data === STATES.PAUSED) {
              this.bufferingFromPlaying = false;
              this.emit("pause");
            } else if (event.data === STATES.ENDED) {
              this.bufferingFromPlaying = false;
              this.emit("ended");
              this.emit("offline");
            } else {
              if (
                event.data === STATES.BUFFERING &&
                previous !== STATES.BUFFERING
              )
                this.bufferingFromPlaying = previous === STATES.PLAYING;
              this.emit("state");
            }
          },
          onError: () => this.fail(),
        },
      });
    } catch {
      this.fail();
    }
  }

  private fail() {
    if (this.destroyed) return;
    this.failed = true;
    this.wantPlay = false;
    this.bufferingFromPlaying = false;
    this.emit("error");
  }

  private emit(event: string) {
    if (!this.destroyed)
      for (const callback of this.listeners.get(event) || []) callback();
  }

  addEventListener(event: string, callback: () => void) {
    this.listeners.set(event, [...(this.listeners.get(event) || []), callback]);
  }

  getPlayerState() {
    if (this.failed) return { playback: "Error" };
    switch (this.state) {
      case STATES.PLAYING:
        return { playback: "Playing" };
      case STATES.PAUSED:
        return { playback: "Paused" };
      case STATES.BUFFERING:
        return { playback: "Buffering" };
      case STATES.ENDED:
        return { playback: "Offline" };
      default:
        return { playback: "Paused" };
    }
  }

  setControls(_value: boolean) {
    /* YouTube keeps its own controls; the tile header and the global keys drive it */
  }
  setQuality(_value: string) {
    /* the YouTube player chooses its own resolution */
  }
  getQuality() {
    return "auto";
  }
  setSpotlight(_front: boolean, _available: boolean) {
    /* the tile header owns the spotlight button */
  }
  setMuted(value: boolean) {
    this.muted = value;
    if (!this.player) return;
    if (value) this.player.mute();
    else this.player.unMute();
  }
  getMuted() {
    if (!this.ready || !this.player) return this.muted;
    return this.player.isMuted();
  }
  setVolume(value: number) {
    this.volume = Math.max(0, Math.min(1, value));
    this.player?.setVolume(this.volume * 100);
  }
  getVolume() {
    if (!this.ready || !this.player) return this.volume;
    return this.player.getVolume() / 100;
  }
  play() {
    if (this.failed) return;
    if (this.ready && this.state === STATES.PLAYING) {
      this.wantPlay = false;
      return;
    }
    this.wantPlay = true;
    if (this.state === STATES.BUFFERING) return;
    if (this.ready) this.player?.playVideo();
  }
  pause() {
    if (this.failed) return;
    this.bufferingFromPlaying = false;
    this.wantPlay = false;
    this.player?.pauseVideo();
  }
  destroy() {
    this.destroyed = true;
    this.listeners.clear();
    try {
      this.player?.destroy();
    } catch {
      /* a player that never finished loading has nothing to remove */
    }
    this.player = null;
    this.target.remove();
    this.element.replaceChildren();
  }
}
