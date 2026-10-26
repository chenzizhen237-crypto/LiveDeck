// xgplayer-hls.js 3.0.24 starts a 1 s statistics interval in every register()
// (each URL change) and never clears it, not even in destroy(). Each reload or
// closed player leaked a timer that kept emitting into a dead player.

import HlsJsPlugin from "xgplayer-hls.js";

type Base = { register(url: string): void; destroy(): void; _statisticsTimmer?: ReturnType<typeof setInterval> | null };

const Parent = HlsJsPlugin as unknown as { new (args: unknown): Base; pluginName: string };

export default class SafeHlsJsPlugin extends Parent {
  static get pluginName() {
    return "HlsJsPlugin";
  }

  register(url: string) {
    this.clearStatistics();
    super.register(url);
  }

  destroy() {
    this.clearStatistics();
    super.destroy();
  }

  private clearStatistics() {
    if (this._statisticsTimmer) clearInterval(this._statisticsTimmer);
    this._statisticsTimmer = null;
  }
}
