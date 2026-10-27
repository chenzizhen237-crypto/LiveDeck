// Split playback monitor: the browser side. One shared 1 s scheduler samples
// every tracked tile (media element counters, buffered range, player/hls.js
// events) and the native stats command, feeds the pure MetricsModel, and
// publishes a snapshot for the chip, popover and Playback monitor.
// Collection is counters and events only: no pixels, no per-frame callbacks.

import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

import {
  MetricsModel,
  msg,
  type Msg,
  type Lifecycle,
  type StreamProfile,
  type SystemAssessment,
  type TileInfo,
  type Transport,
  type TransportEventKind
} from "./model";

const SAMPLE_MS = 1000;
const NATIVE_EVERY = 2;
/** A heartbeat this late means sleep / suspended timers: discard rates spanning it. */
const DISCONTINUITY_MS = 5000;
const EVENT_LOG_MAX = 60;
/** No rendered frame for this long: the window is off-screen/occluded (WebKit stops frames, keeps visibilityState "visible"). */
const FRAME_STALL_MS = 500;
/** After frames come back, buffers and media time catch up; don't judge that transient. */
const RESUME_GRACE_MS = 3000;

export interface MonitorEvent {
  at: number; // Date.now()
  tone: "good" | "warn" | "bad" | "observe" | "unknown";
  icon: string;
  text: Msg;
}

export interface TileView {
  id: string;
  label: string;
  platform: string;
  transport: Transport;
  relayed: boolean;
  profile: StreamProfile;
  timeline: { from: number; to: number; lifecycle: Lifecycle | "stall" }[];
  /** forward buffer, last 60 s */
  buffer: { t: number; v: number | null }[];
}

export interface MonitorSnapshot {
  now: number;
  startedAt: number;
  assessment: SystemAssessment;
  tiles: TileView[];
  device: { uiDelayP95: number | null; cpuPercent: number | null; cpuCores: number | null };
  network: {
    /** Internet-boundary receive: relay upstream bytes (once per connection) + player bytes for direct streams */
    mbps: number | null;
    relayStreams: number;
    directStreams: number;
    uncovered: string[];
  };
  coverage: { buffer: [number, number]; frames: [number, number]; relay: number; hls: number; native: boolean };
  workloadVersion: number;
  events: MonitorEvent[];
}

interface Tracked {
  info: TileInfo;
  player: any | null;
  /** status the tile reports when there's no player (connecting/offline/error) */
  status: "connecting" | "playing" | "offline" | "error";
  waiting: boolean;
  hls: any | null;
  hlsBytes: number;
  detach: (() => void) | null;
}

const model = new MetricsModel();
const tracked = new Map<string, Tracked>();
const listeners = new Set<() => void>();
let timer = 0;
let tickCount = 0;
let lastBeat = 0;
let startedAt = 0;
let snapshot: MonitorSnapshot | null = null;
let events: MonitorEvent[] = [];
let lastState: string | null = null;
let native: { relay: { key: string; upstream_bytes: number; connections: number }[]; at: number } | null = null;
let relayRate = new Map<string, number>();
let hasNative = false;
// Frame heartbeat: the only reliable "is this window actually on screen" signal.
let lastFrame = 0;
let rafId = 0;
let graceUntil = 0;
let wasRendering = true;

function frameLoop(t: number) {
  if (lastFrame && t - lastFrame > 1000) graceUntil = t + RESUME_GRACE_MS;
  lastFrame = t;
  rafId = requestAnimationFrame(frameLoop);
}

/** Visible and actually rendering, outside the post-resume grace period. */
function isRendering(now: number) {
  return !document.hidden && now - lastFrame < FRAME_STALL_MS && now >= graceUntil;
}

function log(tone: MonitorEvent["tone"], icon: string, text: Msg) {
  events = [{ at: Date.now(), tone, icon, text }, ...events].slice(0, EVENT_LOG_MAX);
}

/** `http://127.0.0.1:<port>/live/<key>.flv` → key; null for direct CDN URLs. */
export function relayKeyOf(url: string): string | null {
  const m = /^http:\/\/127\.0\.0\.1:\d+\/live(?:\/([^/?#]+))?\.flv/.exec(url);
  if (!m) return null;
  return m[1] ? decodeURIComponent(m[1]) : "default";
}

// ---------------------------------------------------------------- tracking

export interface TrackOptions {
  id: string;
  label: string;
  platform: string;
  streamUrl: string;
  isHls: boolean;
}

/** Call when a tile's player is created (also on every reload). Returns a detach function for the player's teardown. */
export function trackTilePlayer(opts: TrackOptions, player: any): () => void {
  const now = performance.now();
  const relayKey = relayKeyOf(opts.streamUrl);
  const info: TileInfo = {
    id: opts.id,
    label: opts.label,
    platform: opts.platform,
    transport: opts.isHls ? "hls" : "flv",
    relayed: relayKey !== null,
    relayKey
  };
  const existing = tracked.get(opts.id);
  if (existing) {
    existing.detach?.();
    model.register(info, now);
    model.newEpoch(opts.id, now);
  } else {
    model.register(info, now);
    log("observe", "layers", msg("log.tileAdded", { label: opts.label }));
  }
  const t: Tracked = existing ?? { info, player: null, status: "connecting", waiting: false, hls: null, hlsBytes: 0, detach: null };
  Object.assign(t, { info, player, status: "connecting", waiting: false, hls: null, hlsBytes: 0 });
  tracked.set(opts.id, t);

  const on = (ev: string, fn: (...a: any[]) => void) => {
    player?.on?.(ev, fn);
    return () => player?.off?.(ev, fn);
  };
  const offs = [
    on("playing", () => {
      t.status = "playing";
      t.waiting = false;
      model.firstFrame(opts.id, performance.now());
    }),
    on("waiting", () => (t.waiting = true)),
    on("canplay", () => (t.waiting = false)),
    on("error", () => {
      transport(opts.id, "pipeline-error");
      t.status = "error";
    }),
    on("core_event", (e: any) => {
      if (e?.eventName === "core.loadretry") transport(opts.id, "retry");
    })
  ];
  // Idempotent and bound to this player: a stale detach (late teardown of an
  // older player) must not unhook the newer one that replaced it.
  let done = false;
  const detachThis = () => {
    if (done) return;
    done = true;
    offs.forEach((f) => f());
    if (t.player === player) {
      t.player = null;
      t.hls = null;
    }
    if (t.detach === detachThis) t.detach = null;
  };
  t.detach = detachThis;
  ensureRunning();
  return detachThis;
}

/** Tile state when it has no working player (connecting, offline, error). */
export function setTileStatus(id: string, status: Tracked["status"], label?: string) {
  const t = tracked.get(id);
  if (!t) return;
  if (label) t.info = { ...t.info, label };
  if (status === "error" && t.status !== "error") log("bad", "circle-x", msg("log.tileFailed", { label: t.info.label }));
  t.status = status;
}

/** Update a tile's display name (e.g. once the anchor name is known). */
export function renameTile(id: string, label: string) {
  const t = tracked.get(id);
  if (t && label) t.info = { ...t.info, label };
}

/** The tile left the split / the room was closed. Safe to call twice. */
export function untrackTile(id: string) {
  const t = tracked.get(id);
  if (!t) return;
  t.detach?.();
  tracked.delete(id);
  model.unregister(id, performance.now());
  log("observe", "layers", msg("log.tileRemoved", { label: t.info.label }));
  if (tracked.size === 0) stop();
}

function transport(id: string, kind: TransportEventKind, segmentRatio?: number) {
  model.addEvent(id, { t: performance.now(), kind, segmentRatio });
  if (kind === "reconnect" || kind === "timeout") {
    const t = tracked.get(id);
    log("warn", kind === "reconnect" ? "rotate-cw" : "clock", msg(kind === "reconnect" ? "log.reconnecting" : "log.timeout", { label: t?.info.label ?? id }));
  }
}

/** hls.js instance lives on the plugin and can be recreated on URL changes. */
function attachHls(id: string, t: Tracked) {
  const hls = t.player?.plugins?.hlsjsplugin?.hls ?? null;
  if (!hls || hls === t.hls) return;
  t.hls = hls;
  const Events = hls.constructor?.Events ?? {};
  hls.on?.(Events.FRAG_LOADED ?? "hlsFragLoaded", (_e: unknown, data: any) => {
    const stats = data?.frag?.stats ?? data?.stats;
    const dur = data?.frag?.duration;
    if (stats?.loaded) t.hlsBytes += stats.loaded;
    const start = stats?.loading?.start ?? stats?.trequest;
    const end = stats?.loading?.end ?? stats?.tload;
    if (dur > 0 && end > start) transport(id, "segment", (end - start) / 1000 / dur);
  });
  hls.on?.(Events.ERROR ?? "hlsError", (_e: unknown, data: any) => {
    const d = String(data?.details ?? "");
    if (/TimeOut/i.test(d)) transport(id, "timeout");
    else if (/LoadError/i.test(d)) transport(id, "http-error");
  });
  hls.on?.(Events.MANIFEST_PARSED ?? "hlsManifestParsed", (_e: unknown, data: any) => {
    const level = data?.levels?.[0];
    if (level) model.setProfile(id, { codec: level.videoCodec ?? null, fps: level.frameRate ?? null });
  });
}

// ---------------------------------------------------------------- sampling

function bufferAhead(v: HTMLVideoElement): number | null {
  const b = v.buffered;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= v.currentTime + 0.1 && v.currentTime <= b.end(i)) return Math.max(0, b.end(i) - v.currentTime);
  }
  return b.length ? 0 : null;
}

function sampleTile(id: string, t: Tracked, now: number) {
  const video: HTMLVideoElement | null = t.player?.media ?? t.player?.video ?? null;
  let lifecycle: Lifecycle;
  if (!isRendering(now)) lifecycle = "hidden";
  else if (t.status === "offline") lifecycle = "offline";
  else if (t.status === "error") lifecycle = "error";
  // Before a first frame; the model treats it as a reconnect if the tile played in an earlier epoch.
  else if (!video || t.status === "connecting") lifecycle = "connecting";
  else if (video.paused && !t.waiting) lifecycle = "paused";
  else if (t.waiting || video.readyState < 3) lifecycle = "buffering";
  else lifecycle = "playing";

  let dropped: number | null = null;
  let total: number | null = null;
  const q = video?.getVideoPlaybackQuality?.();
  if (q && q.totalVideoFrames > 0) {
    dropped = q.droppedVideoFrames;
    total = q.totalVideoFrames;
  }

  let rx: number | null = null;
  if (t.info.transport === "hls") {
    attachHls(id, t);
    rx = t.hls ? t.hlsBytes : null;
  } else {
    const stats = t.player?.plugins?.flv?.core?.getStats?.();
    if (stats) {
      rx = typeof stats.totalReceivedByte === "number" ? stats.totalReceivedByte : null;
      model.setProfile(id, {
        codec: stats.videoCodec || null,
        fps: stats.fps > 0 ? Math.round(stats.fps) : null,
        width: stats.width || null,
        height: stats.height || null
      });
    }
  }
  if (video && video.videoWidth) model.setProfile(id, { width: video.videoWidth, height: video.videoHeight });

  model.addSample(id, {
    t: now,
    lifecycle,
    mediaTime: video ? video.currentTime : null,
    bufferAhead: video ? bufferAhead(video) : null,
    droppedFrames: dropped,
    totalFrames: total,
    rxBytes: rx
  });
}

async function pollNative() {
  try {
    const r = await invoke<{ relay: { key: string; upstream_bytes: number; connections: number }[]; cpu_percent: number | null; cpu_cores: number | null }>(
      "playback_native_stats"
    );
    hasNative = true;
    model.setDevice(r.cpu_percent, r.cpu_cores);
    const at = performance.now();
    if (native) {
      const sec = (at - native.at) / 1000;
      const prev = new Map(native.relay.map((k) => [k.key, k.upstream_bytes]));
      relayRate = new Map(
        r.relay.map((k) => [k.key, sec > 0 && prev.has(k.key) ? Math.max(0, (k.upstream_bytes - (prev.get(k.key) as number)) * 8 / sec / 1e6) : NaN])
      );
    }
    native = { relay: r.relay, at };
  } catch {
    hasNative = false;
    model.setDevice(null, null);
  }
}

function tick() {
  const now = performance.now();
  const intended = lastBeat + SAMPLE_MS;
  const late = now - intended;
  lastBeat = now;
  if (late > DISCONTINUITY_MS) {
    model.discontinuity(now);
    native = null;
    log("unknown", "moon", msg("log.resumed"));
  } else if (isRendering(now)) {
    model.heartbeatLate(now, late);
  }
  const rendering = isRendering(now);
  if (rendering !== wasRendering) {
    if (!rendering) log("unknown", "eye-off", msg("log.windowHidden"));
    wasRendering = rendering;
  }

  for (const [id, t] of tracked) sampleTile(id, t, now);
  if (tickCount++ % NATIVE_EVERY === 0) void pollNative();
  publish(now);
}

function publish(now: number) {
  const assessment = model.assess(now);
  if (assessment.state !== lastState) {
    const tone = assessment.state === "healthy" ? "good" : assessment.state === "observing" ? "observe" : assessment.state === "isolated" ? "warn" : "warn";
    if (lastState !== null) log(tone, "activity", assessment.headline);
    lastState = assessment.state;
  }

  const tiles: TileView[] = [...tracked.values()].map((t) => ({
    id: t.info.id,
    label: t.info.label,
    platform: t.info.platform,
    transport: t.info.transport,
    relayed: t.info.relayed,
    profile: model.profile(t.info.id) ?? { width: null, height: null, fps: null, codec: null },
    timeline: model.timeline(t.info.id),
    buffer: model.bufferSeries(t.info.id, now, 60_000)
  }));

  // Network at the Internet boundary, each connection's upstream counted once.
  const relayKeys = new Set(tiles.filter((t) => t.relayed).map((t) => tracked.get(t.id)?.info.relayKey).filter(Boolean) as string[]);
  let mbps = 0;
  let known = false;
  const uncovered: string[] = [];
  for (const k of relayKeys) {
    const r = relayRate.get(k);
    if (r !== undefined && !Number.isNaN(r)) {
      mbps += r;
      known = true;
    }
  }
  let direct = 0;
  for (const a of assessment.tiles) {
    const t = tracked.get(a.id);
    if (!t || t.info.relayed || a.health === "excluded") continue;
    direct++;
    if (a.metrics.rxMbps !== null) {
      mbps += a.metrics.rxMbps;
      known = true;
    } else uncovered.push(t.info.label);
  }

  const counted = assessment.tiles.filter((t) => t.health !== "excluded");
  snapshot = {
    now,
    startedAt,
    assessment,
    tiles,
    device: { ...model.deviceSignals() },
    network: { mbps: known ? mbps : null, relayStreams: relayKeys.size, directStreams: direct, uncovered },
    coverage: {
      buffer: [counted.filter((t) => t.metrics.bufferAhead !== null).length, counted.length],
      frames: [counted.filter((t) => t.metrics.dropRatio !== null).length, counted.length],
      relay: tiles.filter((t) => t.relayed).length,
      hls: tiles.filter((t) => t.transport === "hls").length,
      native: hasNative
    },
    workloadVersion: model.workloadVersion,
    events
  };
  listeners.forEach((l) => l());
}

function ensureRunning() {
  if (timer) return;
  startedAt = performance.now();
  lastBeat = startedAt;
  lastFrame = startedAt;
  rafId = requestAnimationFrame(frameLoop);
  events = [];
  lastState = null;
  timer = window.setInterval(tick, SAMPLE_MS);
}

function stop() {
  window.clearInterval(timer);
  timer = 0;
  cancelAnimationFrame(rafId);
  snapshot = null;
  native = null;
  listeners.forEach((l) => l());
}

// ---------------------------------------------------------------- React

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Latest monitor snapshot; null while no tile is tracked. */
export function usePlaybackMonitor(): MonitorSnapshot | null {
  return useSyncExternalStore(subscribe, () => snapshot, () => null);
}

// ---------------------------------------------------------------- open state

let monitorOpen = false;
const openListeners = new Set<() => void>();
const emitOpen = () => openListeners.forEach((l) => l());

export function openPlaybackMonitor() {
  // Player (element) fullscreen would hide an app-level overlay.
  if (typeof document !== "undefined" && document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
  monitorOpen = true;
  emitOpen();
}

export function closePlaybackMonitor() {
  monitorOpen = false;
  emitOpen();
}

export function togglePlaybackMonitor() {
  if (monitorOpen) closePlaybackMonitor();
  else openPlaybackMonitor();
}

export function usePlaybackMonitorOpen(): boolean {
  return useSyncExternalStore(
    (fn) => {
      openListeners.add(fn);
      return () => openListeners.delete(fn);
    },
    () => monitorOpen,
    () => false
  );
}
