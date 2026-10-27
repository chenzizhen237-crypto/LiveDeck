// Split playback health: the pure part (no DOM, no Tauri), see
// docs/split-playback-metrics.md. The sampler feeds one Sample per tile per
// second plus transport events; this module turns them into per-tile metrics,
// a system classification and one-step add advice.
//
// Rules that matter more than the numbers:
//   - unknown/stale data is `null`, never 0 or healthy;
//   - a tile that was healthy and then failed stays counted (it can't vanish);
//   - hidden, paused, startup and settling time are excluded from denominators;
//   - no capacity number is produced anywhere.
// Thresholds are the doc's provisional starting points.

export type Lifecycle =
  | "connecting"
  | "playing"
  | "buffering"
  | "reconnecting"
  | "paused"
  | "offline"
  | "error"
  | "hidden";

export type Transport = "flv" | "hls";

export interface Sample {
  /** Monotonic ms (performance.now()). */
  t: number;
  lifecycle: Lifecycle;
  /** media currentTime, s */
  mediaTime: number | null;
  /** end of the buffered range containing currentTime − currentTime, s */
  bufferAhead: number | null;
  droppedFrames: number | null;
  totalFrames: number | null;
  /** cumulative bytes the player consumed (its own boundary) */
  rxBytes: number | null;
}

/** "segment" records one HLS segment's timing (not an incident). */
export type TransportEventKind = "timeout" | "http-error" | "retry" | "reconnect" | "pipeline-error" | "segment";

export interface TransportEvent {
  t: number;
  kind: TransportEventKind;
  /** HLS: segment download wall time / media duration */
  segmentRatio?: number;
}

export interface StreamProfile {
  width: number | null;
  height: number | null;
  fps: number | null;
  codec: string | null;
}

export interface TileInfo {
  id: string;
  label: string;
  platform: string;
  transport: Transport;
  /** true when the stream goes through the local relay (its upstream bytes are counted there) */
  relayed: boolean;
  relayKey: string | null;
}

export const SYMPTOM_WINDOW_MS = 10_000;
export const DECISION_WINDOW_MS = 30_000;
export const HISTORY_MS = 5 * 60_000;
export const SETTLE_MS = 5_000;
export const MIN_VALID_MS = 20_000;
export const STALE_MS = 3_000;
export const RECOVERY_MS = 30_000;
const DROP_RATIO_CONCERN = 0.01;
const MIN_FRAMES_PER_WINDOW = 100;
const LOW_BUFFER_S = 1;
const SUFFICIENT_BUFFER_S = 2;
/** Media time must advance at least this fraction of wall time to count as progress. */
const PROGRESS_FRACTION = 0.5;
/** A sample gap longer than this (sleep, throttled tab) breaks continuity. */
const MAX_SAMPLE_GAP_MS = 3_000;

export interface TileMetrics {
  /** eligible (steady-playback) ms in the decision window */
  eligibleMs: number;
  /** valid ms since this epoch settled, capped at the history */
  validMs: number;
  rebufferRatio: number | null;
  /** longest unintended interruption in the decision window, s (an open one counts) */
  longestStallS: number | null;
  stallMsTotal: number;
  /** ΔdroppedVideoFrames / ΔtotalVideoFrames over the decision window */
  dropRatio: number | null;
  bufferAhead: number | null;
  /** s of buffer per s of wall time over the symptom window */
  bufferSlope: number | null;
  rxMbps: number | null;
  incidents: number;
  segmentRatio: number | null;
}

export type TileHealth = "observing" | "healthy" | "warning" | "excluded" | "unknown";

export type TileReason = "interruption" | "draining" | "presentation" | "transport";

export interface TileAssessment {
  id: string;
  lifecycle: Lifecycle | null;
  health: TileHealth;
  reasons: TileReason[];
  metrics: TileMetrics;
  /** human-readable one-liner for the popover/table */
  detail: string;
  excludedReason: string | null;
}

export type SystemState = "observing" | "healthy" | "delivery" | "local" | "isolated" | "unclear";
export type Advice = "try" | "likely" | "wait" | "avoid";

export interface DeviceSignals {
  /** p95 of the shared heartbeat's lateness over the decision window, ms */
  uiDelayP95: number | null;
  /** app process CPU, percent of one core */
  cpuPercent: number | null;
  cpuCores: number | null;
}

export interface SystemAssessment {
  state: SystemState;
  advice: Advice;
  headline: string;
  detail: string;
  evidence: string[];
  affected: string[];
  tiles: TileAssessment[];
  /** worst values across eligible tiles, never averaged */
  worst: {
    rebuffer: { tile: string; value: number } | null;
    longestStall: { tile: string; value: number } | null;
    dropRatio: { tile: string; value: number } | null;
  };
}

interface TileRecord {
  info: TileInfo;
  epoch: number;
  epochStart: number;
  firstFrameAt: number | null;
  /** reached a first frame in any epoch: a reload after that is a reconnect, not a startup */
  everPlayed: boolean;
  samples: Sample[];
  events: TransportEvent[];
  profile: StreamProfile;
  /** last time any warning condition held */
  lastWarnAt: number | null;
}

export interface WorkloadChange {
  t: number;
  version: number;
  description: string;
  /** tile count went up (a natural "addition" observation) */
  addition: boolean;
}

/** Rolling window helpers ------------------------------------------------- */

function windowSamples(samples: Sample[], now: number, ms: number): Sample[] {
  const from = now - ms;
  let i = samples.length;
  while (i > 0 && samples[i - 1].t >= from) i--;
  // include the sample just before the window so its first interval is measured
  return samples.slice(Math.max(0, i - 1));
}

function isSteady(s: Sample): boolean {
  return s.lifecycle === "playing" || s.lifecycle === "buffering" || s.lifecycle === "reconnecting";
}

/** Interval [a,b) is a stall if the player says so, or media time didn't advance while "playing". */
function isStallInterval(a: Sample, b: Sample): boolean {
  if (b.lifecycle === "buffering" || b.lifecycle === "reconnecting") return true;
  if (a.mediaTime === null || b.mediaTime === null) return false;
  const wall = (b.t - a.t) / 1000;
  return wall > 0 && b.mediaTime - a.mediaTime < wall * PROGRESS_FRACTION;
}

export function computeTileMetrics(rec: TileRecord, now: number): TileMetrics {
  const settledAt = rec.firstFrameAt === null ? null : rec.firstFrameAt + SETTLE_MS;
  const win = windowSamples(rec.samples, now, DECISION_WINDOW_MS);
  let eligibleMs = 0;
  let stallMs = 0;
  let longest = 0;
  let run = 0;
  for (let i = 1; i < win.length; i++) {
    const a = win[i - 1];
    const b = win[i];
    const dt = b.t - a.t;
    const from = Math.max(a.t, now - DECISION_WINDOW_MS);
    const counted = b.t - from;
    if (counted <= 0) continue;
    if (dt > MAX_SAMPLE_GAP_MS || settledAt === null || a.t < settledAt || !isSteady(a) || !isSteady(b)) {
      run = 0;
      continue;
    }
    eligibleMs += counted;
    if (isStallInterval(a, b)) {
      stallMs += counted;
      run += counted;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }

  // valid steady time since settling, for the 20 s qualification
  let validMs = 0;
  for (let i = 1; i < rec.samples.length; i++) {
    const a = rec.samples[i - 1];
    const b = rec.samples[i];
    if (settledAt !== null && a.t >= settledAt && b.t - a.t <= MAX_SAMPLE_GAP_MS && isSteady(a) && isSteady(b)) {
      validMs += b.t - a.t;
    }
  }

  // dropped-frame ratio: counter deltas over the window, invalid on resets/unsupported
  let dropRatio: number | null = null;
  const first = win.find((s) => s.totalFrames !== null && s.droppedFrames !== null && settledAt !== null && s.t >= settledAt);
  const last = win[win.length - 1];
  if (first && last && last.totalFrames !== null && last.droppedFrames !== null && first.totalFrames !== null && first.droppedFrames !== null) {
    const dTotal = last.totalFrames - first.totalFrames;
    const dDrop = last.droppedFrames - first.droppedFrames;
    if (dTotal >= MIN_FRAMES_PER_WINDOW && dDrop >= 0) dropRatio = dDrop / dTotal;
  }

  const sym = windowSamples(rec.samples, now, SYMPTOM_WINDOW_MS).filter((s) => s.bufferAhead !== null && isSteady(s));
  let bufferSlope: number | null = null;
  if (sym.length >= 3) {
    const a = sym[0];
    const b = sym[sym.length - 1];
    const wall = (b.t - a.t) / 1000;
    if (wall >= 3) bufferSlope = ((b.bufferAhead as number) - (a.bufferAhead as number)) / wall;
  }

  let rxMbps: number | null = null;
  const rx = win.filter((s) => s.rxBytes !== null);
  if (rx.length >= 2) {
    const a = rx[0];
    const b = rx[rx.length - 1];
    const sec = (b.t - a.t) / 1000;
    const bytes = (b.rxBytes as number) - (a.rxBytes as number);
    if (sec >= 2 && bytes >= 0) rxMbps = (bytes * 8) / sec / 1_000_000;
  }

  const recentEvents = rec.events.filter((e) => e.t >= now - DECISION_WINDOW_MS);
  const ratios = recentEvents.map((e) => e.segmentRatio).filter((r): r is number => typeof r === "number");
  const latest = rec.samples[rec.samples.length - 1];

  return {
    eligibleMs,
    validMs,
    rebufferRatio: eligibleMs >= 1000 ? stallMs / eligibleMs : null,
    longestStallS: eligibleMs >= 1000 ? longest / 1000 : null,
    stallMsTotal: stallMs,
    dropRatio,
    bufferAhead: latest && now - latest.t <= STALE_MS ? latest.bufferAhead : null,
    bufferSlope,
    rxMbps,
    incidents: recentEvents.filter((e) => e.kind !== "segment").length,
    segmentRatio: ratios.length ? ratios.reduce((x, y) => x + y, 0) / ratios.length : null
  };
}

/** Presentation concern needs two consecutive non-overlapping 10 s windows at ≥1 %. */
function presentationConcern(rec: TileRecord, now: number): boolean {
  const ratioIn = (from: number, to: number) => {
    const s = rec.samples.filter((x) => x.t >= from && x.t <= to && x.totalFrames !== null && x.droppedFrames !== null);
    if (s.length < 2) return null;
    const dT = (s[s.length - 1].totalFrames as number) - (s[0].totalFrames as number);
    const dD = (s[s.length - 1].droppedFrames as number) - (s[0].droppedFrames as number);
    if (dT < MIN_FRAMES_PER_WINDOW || dD < 0) return null;
    return dD / dT;
  };
  const a = ratioIn(now - 2 * SYMPTOM_WINDOW_MS, now - SYMPTOM_WINDOW_MS);
  const b = ratioIn(now - SYMPTOM_WINDOW_MS, now);
  return a !== null && b !== null && a >= DROP_RATIO_CONCERN && b >= DROP_RATIO_CONCERN;
}

function fmtS(v: number) {
  return `${v.toFixed(1)} 秒`;
}

export function assessTile(rec: TileRecord, now: number): TileAssessment {
  const latest = rec.samples[rec.samples.length - 1] ?? null;
  const m = computeTileMetrics(rec, now);
  const base = { id: rec.info.id, lifecycle: latest?.lifecycle ?? null, metrics: m };

  if (!latest || now - latest.t > STALE_MS) {
    return { ...base, health: "unknown", reasons: [], detail: "无近期数据", excludedReason: null };
  }
  const reasons: TileReason[] = [];
  if (m.longestStallS !== null && (m.longestStallS >= 1 || m.stallMsTotal >= 2000)) reasons.push("interruption");
  if (latest.lifecycle === "buffering" || latest.lifecycle === "reconnecting") {
    if (!reasons.includes("interruption")) reasons.push("interruption");
  }
  if (m.bufferAhead !== null && m.bufferAhead < LOW_BUFFER_S && m.bufferSlope !== null && m.bufferSlope < 0) reasons.push("draining");
  if (presentationConcern(rec, now)) reasons.push("presentation");
  const transportIncidents = m.incidents;
  if (transportIncidents >= 2 || (m.segmentRatio !== null && m.segmentRatio > 1)) reasons.push("transport");

  // Only transport evidence alone isn't a symptom; it corroborates draining/interruption.
  const symptomatic = reasons.some((r) => r !== "transport");
  if (symptomatic) rec.lastWarnAt = now;
  const inRecovery = rec.lastWarnAt !== null && now - rec.lastWarnAt < RECOVERY_MS;

  // A tile that failed after playing stays in the denominator as a warning.
  if (latest.lifecycle === "error" || latest.lifecycle === "offline") {
    const wasPlaying = rec.firstFrameAt !== null;
    if ((wasPlaying || rec.everPlayed) && latest.lifecycle === "error") {
      rec.lastWarnAt = now;
      return { ...base, health: "warning", reasons: ["interruption"], detail: "播放后中断", excludedReason: null };
    }
    return { ...base, health: "excluded", reasons: [], detail: latest.lifecycle === "offline" ? "未开播" : "启动失败", excludedReason: latest.lifecycle === "offline" ? "offline" : "startup failure" };
  }
  if (latest.lifecycle === "hidden" || latest.lifecycle === "paused") {
    return { ...base, health: "excluded", reasons: [], detail: latest.lifecycle === "hidden" ? "已隐藏，不计入" : "已暂停", excludedReason: latest.lifecycle };
  }
  // Reloading after it had played: an interruption that stays visible.
  if (rec.everPlayed && (rec.firstFrameAt === null || latest.lifecycle === "reconnecting")) {
    rec.lastWarnAt = now;
    return { ...base, health: "warning", reasons: ["interruption"], detail: "重连中", excludedReason: null };
  }
  if (latest.lifecycle === "connecting" || rec.firstFrameAt === null) {
    return { ...base, health: "excluded", reasons: [], detail: "连接中，不计入", excludedReason: "startup" };
  }

  const parts: string[] = [];
  if (m.bufferAhead !== null) parts.push(`缓冲 ${fmtS(m.bufferAhead)}${m.bufferSlope !== null && m.bufferSlope < -0.05 ? "，持续下降" : ""}`);
  if (m.longestStallS) parts.push(`卡顿 ${fmtS(m.longestStallS)}`);
  if (transportIncidents) parts.push(`${transportIncidents} 次传输异常`);
  if (m.segmentRatio !== null && m.segmentRatio > 1) parts.push(`分片下载耗时 ${m.segmentRatio.toFixed(1)}× 实时`);
  if (reasons.includes("presentation") && m.dropRatio !== null) parts.push(`掉帧 ${(m.dropRatio * 100).toFixed(1)} %`);

  if (symptomatic || inRecovery) {
    const kept = symptomatic ? reasons : (["interruption"] as TileReason[]);
    return { ...base, health: "warning", reasons: symptomatic ? reasons : kept, detail: parts.join("，") || "恢复中", excludedReason: null };
  }
  if (m.validMs < MIN_VALID_MS) {
    return { ...base, health: "observing", reasons: [], detail: "稳定中", excludedReason: null };
  }
  return { ...base, health: "healthy", reasons: [], detail: parts.join("，") || "流畅", excludedReason: null };
}

/** System classification -------------------------------------------------- */

const DELIVERY: TileReason[] = ["interruption", "draining"];

export function classify(
  tiles: TileAssessment[],
  device: DeviceSignals,
  ctx: { now: number; lastChange: WorkloadChange | null; recentSuccessfulAddition: boolean },
  labelOf: (id: string) => string
): SystemAssessment {
  const counted = tiles.filter((t) => t.health !== "excluded");
  const warn = counted.filter((t) => t.health === "warning");
  const healthy = counted.filter((t) => t.health === "healthy");
  const observing = counted.filter((t) => t.health === "observing" || t.health === "unknown");

  const delivery = warn.filter((t) => t.reasons.some((r) => DELIVERY.includes(r)) && (t.metrics.bufferAhead === null || t.metrics.bufferAhead < SUFFICIENT_BUFFER_S));
  const deliveryWithTransport = delivery.filter((t) => t.reasons.includes("transport"));
  const presentation = warn.filter((t) => t.reasons.includes("presentation") && (t.metrics.bufferAhead ?? 0) >= SUFFICIENT_BUFFER_S);
  const localCorroborated =
    (device.uiDelayP95 !== null && device.uiDelayP95 >= 50) ||
    (device.cpuPercent !== null && device.cpuCores !== null && device.cpuPercent >= 0.85 * 100 * device.cpuCores);

  const worstBy = (pick: (m: TileMetrics) => number | null) => {
    let best: { tile: string; value: number } | null = null;
    for (const t of counted) {
      const v = pick(t.metrics);
      if (v !== null && (!best || v > best.value)) best = { tile: labelOf(t.id), value: v };
    }
    return best;
  };
  const worst = {
    rebuffer: worstBy((m) => m.rebufferRatio),
    longestStall: worstBy((m) => m.longestStallS),
    dropRatio: worstBy((m) => m.dropRatio)
  };
  const deviceEvidence = [
    device.uiDelayP95 !== null ? `界面延迟 p95 ${Math.round(device.uiDelayP95)} ms` : "界面延迟不可用",
    device.cpuPercent !== null ? `应用 CPU ${Math.round(device.cpuPercent)} %` : "CPU 不可用"
  ].join("，");

  const recentChange = ctx.lastChange !== null && ctx.now - ctx.lastChange.t < MIN_VALID_MS;
  const n = counted.length;
  const base = { tiles, worst, affected: warn.map((t) => t.id) };

  let state: SystemState;
  let headline: string;
  let detail: string;
  const evidence: string[] = [];

  if (warn.length === 0) {
    if (n === 0 || observing.length > 0 || healthy.length === 0 || recentChange) {
      state = "observing";
      headline = ctx.lastChange && recentChange ? "变更后重新观察…" : "正在观察播放…";
      detail = ctx.lastChange && recentChange ? ctx.lastChange.description : "需要至少 20 秒可比较的播放数据。";
    } else {
      state = "healthy";
      headline = `${healthy.length} 路画面播放流畅`;
      detail = "近期没有卡顿。剩余带宽和解码余量并未得到验证。";
      evidence.push(`最近 30 秒内 ${healthy.length} 路画面没有中断`, `无本机压力：${deviceEvidence}`);
    }
  } else if (delivery.length >= 2 && presentation.length >= 2 && localCorroborated) {
    state = "unclear";
    headline = "播放不稳定，原因不明";
    detail = "同时出现传输问题和本机压力。";
    evidence.push(`${delivery.length} 路画面缓冲下降或卡顿`, `${presentation.length} 路画面在有缓冲时掉帧`, deviceEvidence);
  } else if (delivery.length >= 2) {
    state = "delivery";
    headline = "数据传输跟不上";
    detail = `${delivery.length} 路画面缓冲在下降${deliveryWithTransport.length ? "，且传输反复延迟" : ""}。`;
    evidence.push(`${delivery.length} 路独立画面在同一 30 秒内缓冲耗尽或卡顿`);
    if (deliveryWithTransport.length) evidence.push(`其中 ${deliveryWithTransport.length} 路出现传输异常`);
    evidence.push(localCorroborated ? `同时存在本机压力：${deviceEvidence}` : `无本机压力：${deviceEvidence}`);
  } else if (presentation.length >= 2 && localCorroborated) {
    state = "local";
    headline = "这台设备有点跟不上";
    detail = "多路画面在缓冲充足的情况下掉帧。";
    evidence.push(`${presentation.length} 路画面掉帧 ≥ 1 %，缓冲 ≥ 2 秒`, deviceEvidence);
  } else if (warn.length === 1 && healthy.length >= 1) {
    state = "isolated";
    headline = "有一路画面不稳定";
    detail = `${labelOf(warn[0].id)}：${warn[0].detail}。其他画面正常。`;
    evidence.push(`其余 ${healthy.length} 路画面在同一时段正常`);
  } else {
    state = "unclear";
    headline = "播放不稳定，原因不明";
    detail = presentation.length ? "画面在有缓冲时掉帧，但没有本机压力佐证。" : "症状无法指向单一原因。";
    evidence.push(`${warn.length} 路画面受影响`, deviceEvidence);
  }

  let advice: Advice;
  if (state === "delivery" || state === "local" || state === "unclear") advice = "avoid";
  else if (state === "observing" || state === "isolated") advice = "wait";
  else advice = ctx.recentSuccessfulAddition ? "likely" : "try";

  return { ...base, state, advice, headline, detail, evidence };
}

/** Stateful store ---------------------------------------------------------- */

export class MetricsModel {
  private tiles = new Map<string, TileRecord>();
  private heartbeat: { t: number; lateMs: number }[] = [];
  private device: { cpuPercent: number | null; cpuCores: number | null } = { cpuPercent: null, cpuCores: null };
  private changes: WorkloadChange[] = [];
  private version = 0;
  private additions: { t: number; version: number; ok: boolean | null }[] = [];

  register(info: TileInfo, now: number) {
    const existing = this.tiles.get(info.id);
    if (existing) {
      existing.info = info;
      return;
    }
    this.tiles.set(info.id, { info, epoch: 0, epochStart: now, firstFrameAt: null, everPlayed: false, samples: [], events: [], profile: { width: null, height: null, fps: null, codec: null }, lastWarnAt: null });
    this.workloadChanged(now, `已加入：${info.label}`, true);
  }

  unregister(id: string, now: number) {
    const rec = this.tiles.get(id);
    if (!rec) return;
    this.tiles.delete(id);
    this.workloadChanged(now, `已移除：${rec.info.label}`, false);
  }

  /** Reload or player replacement: counters restart, history of incidents stays. */
  newEpoch(id: string, now: number) {
    const rec = this.tiles.get(id);
    if (!rec) return;
    rec.epoch += 1;
    rec.epochStart = now;
    rec.firstFrameAt = null;
    rec.samples = [];
  }

  firstFrame(id: string, now: number) {
    const rec = this.tiles.get(id);
    if (rec && rec.firstFrameAt === null) {
      rec.firstFrameAt = now;
      rec.everPlayed = true;
    }
  }

  setProfile(id: string, profile: Partial<StreamProfile>) {
    const rec = this.tiles.get(id);
    if (rec) rec.profile = { ...rec.profile, ...Object.fromEntries(Object.entries(profile).filter(([, v]) => v !== null && v !== undefined)) };
  }

  addSample(id: string, s: Sample) {
    const rec = this.tiles.get(id);
    if (!rec) return;
    const prev = rec.samples[rec.samples.length - 1];
    // counters went backwards inside an epoch: treat as a reset
    if (prev && ((s.totalFrames !== null && prev.totalFrames !== null && s.totalFrames < prev.totalFrames) || (s.rxBytes !== null && prev.rxBytes !== null && s.rxBytes < prev.rxBytes))) {
      rec.samples = [];
    }
    rec.samples.push(s);
    const cut = s.t - HISTORY_MS;
    while (rec.samples.length && rec.samples[0].t < cut) rec.samples.shift();
  }

  addEvent(id: string, e: TransportEvent) {
    const rec = this.tiles.get(id);
    if (!rec) return;
    rec.events.push(e);
    const cut = e.t - HISTORY_MS;
    while (rec.events.length && rec.events[0].t < cut) rec.events.shift();
  }

  heartbeatLate(now: number, lateMs: number) {
    this.heartbeat.push({ t: now, lateMs: Math.max(0, lateMs) });
    while (this.heartbeat.length && this.heartbeat[0].t < now - DECISION_WINDOW_MS) this.heartbeat.shift();
  }

  /** After sleep/resume: drop rates that span the gap. */
  discontinuity(now: number) {
    this.heartbeat = [];
    for (const rec of this.tiles.values()) rec.samples = rec.samples.filter((s) => s.t >= now);
  }

  setDevice(cpuPercent: number | null, cpuCores: number | null) {
    this.device = { cpuPercent, cpuCores };
  }

  workloadChanged(now: number, description: string, addition: boolean) {
    this.version += 1;
    const change = { t: now, version: this.version, description, addition };
    this.changes.push(change);
    if (this.changes.length > 50) this.changes.shift();
    if (addition) this.additions.push({ t: now, version: this.version, ok: null });
  }

  get workloadVersion() {
    return this.version;
  }

  get changeLog(): readonly WorkloadChange[] {
    return this.changes;
  }

  tileInfo(id: string) {
    return this.tiles.get(id)?.info ?? null;
  }

  profile(id: string) {
    return this.tiles.get(id)?.profile ?? null;
  }

  tileIds() {
    return [...this.tiles.keys()];
  }

  /** Recent lifecycle per tile, for the timeline: [{t, lifecycle}] runs. */
  timeline(id: string): { from: number; to: number; lifecycle: Lifecycle | "stall" }[] {
    const rec = this.tiles.get(id);
    if (!rec) return [];
    const runs: { from: number; to: number; lifecycle: Lifecycle | "stall" }[] = [];
    for (let i = 0; i < rec.samples.length; i++) {
      const s = rec.samples[i];
      const prev = rec.samples[i - 1];
      const kind: Lifecycle | "stall" = prev && s.lifecycle === "playing" && isStallInterval(prev, s) ? "stall" : s.lifecycle;
      const last = runs[runs.length - 1];
      if (last && last.lifecycle === kind && s.t - last.to <= MAX_SAMPLE_GAP_MS) last.to = s.t;
      else runs.push({ from: prev && s.t - prev.t <= MAX_SAMPLE_GAP_MS ? prev.t : s.t, to: s.t, lifecycle: kind });
    }
    return runs;
  }

  /** Forward buffer over the last `ms`, for sparklines (null gaps where unknown). */
  bufferSeries(id: string, now: number, ms: number): { t: number; v: number | null }[] {
    const rec = this.tiles.get(id);
    if (!rec) return [];
    return rec.samples.filter((s) => s.t >= now - ms).map((s) => ({ t: s.t, v: s.bufferAhead }));
  }

  deviceSignals(): DeviceSignals {
    let uiDelayP95: number | null = null;
    if (this.heartbeat.length >= 10) {
      const sorted = this.heartbeat.map((h) => h.lateMs).sort((a, b) => a - b);
      uiDelayP95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    }
    return { uiDelayP95, ...this.device };
  }

  assess(now: number): SystemAssessment {
    const tiles = [...this.tiles.values()].map((rec) => assessTile(rec, now));
    // Settle pending addition observations: ok if the system stayed healthy 60 s after it.
    const healthyNow = tiles.every((t) => t.health === "healthy" || t.health === "excluded") && tiles.some((t) => t.health === "healthy");
    for (const a of this.additions) {
      if (a.ok !== null) continue;
      if (!healthyNow && now - a.t > MIN_VALID_MS) a.ok = false;
      else if (healthyNow && now - a.t >= 60_000) a.ok = true;
    }
    // Evidence expires after 10 min or once a later change happened that wasn't an addition.
    const lastNonAddition = [...this.changes].reverse().find((c) => !c.addition);
    const recentSuccessfulAddition = this.additions.some(
      (a) => a.ok === true && now - a.t < 10 * 60_000 && (!lastNonAddition || a.t > lastNonAddition.t)
    );
    const lastChange = this.changes[this.changes.length - 1] ?? null;
    return classify(tiles, this.deviceSignals(), { now, lastChange, recentSuccessfulAddition }, (id) => this.tiles.get(id)?.info.label ?? id);
  }
}
