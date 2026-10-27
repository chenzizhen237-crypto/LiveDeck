// Split playback health model (docs/split-playback-metrics.md).
// Runs on Node 24 with no test deps: `node --test tests/`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { MetricsModel, msg } from "../src/services/playbackMetrics/model.ts";

const tile = (id, extra = {}) => ({ id, label: id, platform: "douyu", transport: "flv", relayed: true, relayKey: `douyu-${id}`, ...extra });

/**
 * Feeds one sample per second from `from` to `to` (seconds). `at(sec)` may
 * override fields; by default the stream plays at 30 fps with 4 s buffered.
 */
function feed(model, id, from, to, at = () => ({})) {
  for (let sec = from; sec <= to; sec++) {
    const o = at(sec) ?? {};
    const base = {
      t: sec * 1000,
      lifecycle: "playing",
      mediaTime: sec,
      bufferAhead: 4,
      droppedFrames: 0,
      totalFrames: sec * 30,
      rxBytes: sec * 400_000
    };
    model.addSample(id, { ...base, ...o });
  }
}

function start(model, id, t = 0, extra) {
  model.register(tile(id, extra), t * 1000);
  model.firstFrame(id, t * 1000);
}

function steadyDevice(model, untilSec) {
  for (let s = 0; s <= untilSec; s++) model.heartbeatLate(s * 1000, 3);
}

test("observing until 20 valid seconds after settling, then healthy with 'try one more'", () => {
  const m = new MetricsModel();
  start(m, "a");
  start(m, "b");
  steadyDevice(m, 60);
  feed(m, "a", 0, 15);
  feed(m, "b", 0, 15);
  assert.equal(m.assess(15_000).state, "observing");
  assert.equal(m.assess(15_000).advice, "wait");
  feed(m, "a", 16, 40);
  feed(m, "b", 16, 40);
  const r = m.assess(40_000);
  assert.equal(r.state, "healthy");
  assert.equal(r.advice, "try");
  assert.equal(r.detail.key, "sys.healthy.detail");
});

test("unsupported frame counters are unknown, not zero, and don't block 'no buffering'", () => {
  const m = new MetricsModel();
  start(m, "a");
  steadyDevice(m, 40);
  feed(m, "a", 0, 40, () => ({ droppedFrames: null, totalFrames: null }));
  const r = m.assess(40_000);
  assert.equal(r.tiles[0].metrics.dropRatio, null);
  assert.equal(r.worst.dropRatio, null);
  assert.equal(r.tiles[0].health, "healthy");
});

test("one stalling stream with healthy peers is isolated, advice waits", () => {
  const m = new MetricsModel();
  for (const id of ["a", "b", "c"]) start(m, id);
  steadyDevice(m, 60);
  feed(m, "a", 0, 60);
  feed(m, "b", 0, 60);
  // c freezes for 3 s near the end
  feed(m, "c", 0, 60, (s) => (s >= 50 && s <= 53 ? { lifecycle: "buffering", mediaTime: 50, bufferAhead: 0 } : s > 53 ? { mediaTime: s - 3 } : {}));
  const r = m.assess(60_000);
  assert.equal(r.state, "isolated");
  assert.equal(r.advice, "wait");
  assert.deepEqual(r.affected, ["c"]);
  assert.ok(r.worst.longestStall.value >= 2.9, `longest ${r.worst.longestStall.value}`);
});

test("several streams draining with transport incidents → delivery trouble, avoid adding", () => {
  const m = new MetricsModel();
  for (const id of ["a", "b", "c"]) start(m, id);
  steadyDevice(m, 60);
  feed(m, "a", 0, 60);
  for (const id of ["b", "c"]) {
    feed(m, id, 0, 60, (s) => (s >= 48 ? { bufferAhead: Math.max(0, 4 - (s - 48) * 0.4), lifecycle: s >= 57 ? "buffering" : "playing", mediaTime: s >= 57 ? 57 : s } : {}));
    m.addEvent(id, { t: 50_000, kind: "timeout" });
    m.addEvent(id, { t: 55_000, kind: "retry" });
  }
  const r = m.assess(60_000);
  assert.equal(r.state, "delivery");
  assert.equal(r.advice, "avoid");
  assert.equal(r.affected.length, 2);
  assert.ok(r.evidence.some((e) => e.key === "ev.transportOn"));
});

test("frame drops with full buffers: local pressure only when the device corroborates it", () => {
  const drops = (s) => ({ droppedFrames: Math.round(s * 30 * 0.03) });
  const build = (uiLate) => {
    const m = new MetricsModel();
    for (const id of ["a", "b"]) start(m, id);
    for (let s = 0; s <= 60; s++) m.heartbeatLate(s * 1000, uiLate);
    feed(m, "a", 0, 60, drops);
    feed(m, "b", 0, 60, drops);
    return m.assess(60_000);
  };
  const corroborated = build(80);
  assert.equal(corroborated.state, "local");
  assert.equal(corroborated.advice, "avoid");
  const bare = build(3);
  assert.equal(bare.state, "unclear", "no device evidence → cause unclear");
});

test("a stream that fails after playing stays counted; startup failures don't", () => {
  const m = new MetricsModel();
  start(m, "a");
  start(m, "b");
  m.register(tile("c"), 0); // never reached first frame
  steadyDevice(m, 60);
  feed(m, "a", 0, 60);
  feed(m, "b", 0, 60, (s) => (s >= 55 ? { lifecycle: "error", mediaTime: 55 } : {}));
  feed(m, "c", 0, 60, () => ({ lifecycle: "error", mediaTime: null, bufferAhead: null, totalFrames: null, droppedFrames: null, rxBytes: null }));
  const r = m.assess(60_000);
  const b = r.tiles.find((t) => t.id === "b");
  const c = r.tiles.find((t) => t.id === "c");
  assert.equal(b.health, "warning");
  assert.equal(c.health, "excluded");
  assert.ok(r.affected.includes("b"));
  assert.notEqual(r.state, "healthy");
});

test("hidden time is excluded, not counted as stalling", () => {
  const m = new MetricsModel();
  start(m, "a");
  start(m, "b");
  steadyDevice(m, 60);
  feed(m, "b", 0, 60);
  feed(m, "a", 0, 60, (s) => (s >= 35 && s <= 45 ? { lifecycle: "hidden", mediaTime: 35 } : s > 45 ? { mediaTime: s - 10 } : {}));
  const r = m.assess(60_000);
  const a = r.tiles.find((t) => t.id === "a");
  assert.equal(a.metrics.stallMsTotal, 0);
  assert.equal(a.health, "healthy");
});

test("a warning holds for 30 s after symptoms stop; absence of data never clears it", () => {
  const m = new MetricsModel();
  start(m, "a");
  start(m, "b");
  steadyDevice(m, 120);
  feed(m, "b", 0, 120);
  feed(m, "a", 0, 40, (s) => (s >= 34 && s <= 37 ? { lifecycle: "buffering", mediaTime: 34 } : s > 37 ? { mediaTime: s - 3 } : {}));
  assert.equal(m.assess(40_000).tiles[0].health, "warning");
  feed(m, "a", 41, 60, (s) => ({ mediaTime: s - 3 }));
  assert.equal(m.assess(60_000).tiles[0].health, "warning", "still within the recovery window");
  // no samples at all for a while → unknown, not healthy
  assert.equal(m.assess(70_000).tiles[0].health, "unknown");
  feed(m, "a", 61, 120, (s) => ({ mediaTime: s - 3 }));
  assert.equal(m.assess(120_000).tiles[0].health, "healthy");
});

test("a recent addition that stayed healthy for 60 s upgrades advice to 'likely'", () => {
  const m = new MetricsModel();
  start(m, "a");
  steadyDevice(m, 200);
  feed(m, "a", 0, 100);
  start(m, "b", 100);
  feed(m, "b", 100, 200);
  feed(m, "a", 101, 200);
  for (let t = 100; t <= 200; t += 10) m.assess(t * 1000);
  const r = m.assess(200_000);
  assert.equal(r.state, "healthy");
  assert.equal(r.advice, "likely");
  // a non-addition change (e.g. quality policy) expires that evidence
  m.workloadChanged(200_000, msg("change.qualityPolicy"), false);
  feed(m, "a", 201, 230);
  feed(m, "b", 201, 230);
  assert.notEqual(m.assess(230_000).advice, "likely");
});

test("counter resets inside an epoch are not read as negative deltas", () => {
  const m = new MetricsModel();
  start(m, "a");
  steadyDevice(m, 60);
  feed(m, "a", 0, 40);
  feed(m, "a", 41, 60, (s) => ({ totalFrames: (s - 41) * 30, droppedFrames: 0, rxBytes: (s - 41) * 400_000 }));
  const r = m.assess(60_000);
  const t = r.tiles[0];
  assert.ok(t.metrics.dropRatio === null || t.metrics.dropRatio >= 0);
  assert.ok(t.metrics.rxMbps === null || t.metrics.rxMbps > 0);
});

test("receive rate uses decimal Mbps", () => {
  const m = new MetricsModel();
  start(m, "a");
  feed(m, "a", 0, 30); // 400 kB/s
  const r = m.assess(30_000);
  assert.ok(Math.abs(r.tiles[0].metrics.rxMbps - 3.2) < 0.01, String(r.tiles[0].metrics.rxMbps));
});

test("a reload after playing counts as a reconnect incident, not a fresh startup", () => {
  const m = new MetricsModel();
  start(m, "a");
  start(m, "b");
  steadyDevice(m, 60);
  feed(m, "a", 0, 60);
  feed(m, "b", 0, 50);
  m.newEpoch("b", 51_000);
  feed(m, "b", 51, 60, () => ({ lifecycle: "reconnecting", mediaTime: null, bufferAhead: null, totalFrames: null, droppedFrames: null, rxBytes: null }));
  const r = m.assess(60_000);
  const b = r.tiles.find((t) => t.id === "b");
  assert.equal(b.health, "warning");
  assert.equal(b.detail[0].key, "tile.reconnecting");
  assert.equal(r.state, "isolated");
});
