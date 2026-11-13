const mockPlayer = `window.Twitch = { Player: class {
  static READY = 'ready'; static PLAYING = 'playing';
  constructor(el, options) { this.options = options; this.muted = true; this.paused = true; this.volume = 0.5;
    this.listeners = {}; this.frame = document.createElement('iframe');
    this.frame.dataset.controls = String(options.controls); el.appendChild(this.frame); }
  addEventListener(event, callback) { (this.listeners[event] ||= []).push(callback);
    if (event === 'ready') setTimeout(() => { if (!this.destroyed) callback(); }, 0); }
  emit(event) { for (const callback of this.listeners[event] || []) callback(); }
  getPlayerState() { return { playback: this.paused ? 'Paused' : 'Playing' }; }
  setMuted(value) { this.muted = value; } getMuted() { return this.muted; }
  setVolume(value) { this.volume = value; } getVolume() { return this.volume; }
  setQuality(value) { this.quality = value; } getQuality() { return this.quality || 'auto'; }
  play() { if (this.paused) { this.paused = false; this.emit('play'); this.emit('playing'); } }
  pause() { if (!this.paused) { this.paused = true; this.emit('pause'); } }
  destroy() { this.destroyed = true; this.frame.remove(); this.listeners = {}; }
}};`;
const mockYouTube = `window.YT = {
  PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  Player: class {
    constructor(node, options) {
      this.node = node; this.options = options; this.state = -1;
      this.muted = false; this.volume = 100; this.destroyed = false;
      this.iframe = document.createElement('iframe');
      node.append(this.iframe);
      setTimeout(() => { if (!this.destroyed) this.options.events?.onReady?.({ target: this }); }, 0);
    }
    playVideo() {
      if (this.destroyed || this.state === 1) return;
      this.state = 1;
      this.options.events?.onStateChange?.({ data: 1, target: this });
    }
    pauseVideo() {
      if (this.destroyed || this.state === 2) return;
      this.state = 2;
      this.options.events?.onStateChange?.({ data: 2, target: this });
    }
    mute() { this.muted = true; }
    unMute() { this.muted = false; }
    isMuted() { return this.muted; }
    setVolume(value) { this.volume = value; }
    getVolume() { return this.volume; }
    getPlayerState() { return this.state; }
    getIframe() { return this.iframe; }
    destroy() { this.destroyed = true; this.iframe.remove(); }
  }
};
window.onYouTubeIframeAPIReady?.();`;
// The preferences live in a modal: open it, pick, and close it so the page is usable again.
async function choose(page, id, value) {
  await page.locator('#settings').click();
  await page.selectOption(id, value);
  await page.keyboard.press('Escape');
  await page.locator('#settings-dialog').waitFor({ state: 'hidden' });
}
module.exports = { mockPlayer, mockYouTube, choose };
