"use client";

// Full Playback monitor (docs/split-playback-metrics.md). The verdict is shown
// as a hypothesis with its evidence; worst-tile values are never averaged;
// unknown is "—", not 0; no capacity or "streams left" number anywhere.

import React, { useRef } from "react";
import { createPortal } from "react-dom";
import { m } from "framer-motion";
import { Activity, CircleCheck, CircleMinus, X } from "lucide-react";

import { PlatformMark } from "@/components/livedeck/primitives";
import type { UiPlatform } from "@/state/category/CategoryProvider";
import { HISTORY_MS } from "@/services/playbackMetrics/model";
import { usePlaybackMonitor, type MonitorEvent, type MonitorSnapshot } from "@/services/playbackMetrics/monitor";

import { ADVICE_META, AdviceTag, Pill, STATE_META, Sparkline, TILE_HEALTH, TONE, fmt, type Tone } from "./health";

const SERIES = 60;

/** Keeps the last SERIES values of a few headline numbers for the stat sparklines. */
function useSeries(snap: MonitorSnapshot | null) {
  const ref = useRef<{ at: number; rebuffer: (number | null)[]; stall: (number | null)[]; drops: (number | null)[]; ui: (number | null)[]; net: (number | null)[] }>({
    at: 0,
    rebuffer: [],
    stall: [],
    drops: [],
    ui: [],
    net: []
  });
  if (snap && snap.now !== ref.current.at) {
    const r = ref.current;
    r.at = snap.now;
    const push = (k: "rebuffer" | "stall" | "drops" | "ui" | "net", v: number | null) => {
      r[k] = [...r[k], v].slice(-SERIES);
    };
    push("rebuffer", snap.assessment.worst.rebuffer?.value ?? null);
    push("stall", snap.assessment.worst.longestStall?.value ?? null);
    push("drops", snap.assessment.worst.dropRatio?.value ?? null);
    push("ui", snap.device.uiDelayP95);
    push("net", snap.network.mbps);
  }
  return ref.current;
}

const cap = "text-[10px] font-bold tracking-[0.08em] text-fg-3";
const card = "rounded-[14px] border border-line bg-surface p-4";

function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`;
}

export function PlaybackMonitor({ onClose, layoutName }: { onClose: () => void; layoutName: string }) {
  const snap = usePlaybackMonitor();
  const series = useSeries(snap);

  // Esc: closed by the host's Esc chain (SplitView).

  return createPortal(
    <m.div
      data-theme="dark"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[600] overflow-y-auto bg-app/95 font-sans text-fg backdrop-blur-xl"
    >
      <div className="mx-auto flex max-w-[1440px] flex-col gap-3.5 px-6 pt-12 pb-6">
        {snap ? <Body snap={snap} series={series} onClose={onClose} layoutName={layoutName} /> : <Empty onClose={onClose} />}
      </div>
    </m.div>,
    document.body
  );
}

function Empty({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-lg font-bold">播放监控</span>
      <span className="text-sm text-fg-2">分屏里没有正在播放的画面。</span>
      <span className="flex-1" />
      <CloseButton onClose={onClose} />
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" onClick={onClose} aria-label="关闭播放监控" className="grid size-9 place-items-center rounded-full bg-chip text-fg-2 hover:bg-hover">
      <X size={16} />
    </button>
  );
}

function Body({ snap, series, onClose, layoutName }: { snap: MonitorSnapshot; series: ReturnType<typeof useSeries>; onClose: () => void; layoutName: string }) {
  const a = snap.assessment;
  const meta = STATE_META[a.state];
  const Icon = meta.icon;
  const counted = a.tiles.filter((t) => t.health !== "excluded").length;

  return (
    <>
      {/* header */}
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-[10px] bg-accent-soft">
          <Activity size={18} className="text-accent" />
        </span>
        <div>
          <div className="text-lg font-bold">播放监控</div>
          <div className="text-xs text-fg-2">
            分屏 {layoutName} · {snap.tiles.length} 路画面 · 已观察 {mmss(snap.now - snap.startedAt)} · 负载 v{snap.workloadVersion}
          </div>
        </div>
        <span className="flex-1" />
        <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-[5px] text-xs font-semibold ${TONE[meta.tone].soft} ${TONE[meta.tone].ring}`}>
          <Icon size={14} className={TONE[meta.tone].text} />
          {a.headline}
        </span>
        <CloseButton onClose={onClose} />
      </div>

      {/* verdict + coverage */}
      <div className="flex gap-3">
        <div className={`${card} flex flex-1 flex-col gap-2.5 ${a.state === "healthy" || a.state === "observing" ? "" : TONE[meta.tone].ring}`}>
          <div className="flex items-center gap-2.5">
            <Icon size={18} className={TONE[meta.tone].text} />
            <span className="text-[15px] font-bold">{a.headline}</span>
            <span className="flex-1" />
            <span className="text-[11px] text-fg-3">{a.state === "healthy" || a.state === "observing" ? "观察结果" : "推断 · 依据如下"}</span>
          </div>
          <div className="text-xs text-fg-2">{a.detail}</div>
          <ul className="flex flex-col gap-1.5">
            {a.evidence.map((e) => (
              <li key={e} className="flex items-start gap-2 text-xs text-fg-2">
                {/^无本机压力|^No local/.test(e) ? <CircleMinus size={14} className="mt-px shrink-0 text-fg-3" /> : <CircleCheck size={14} className={`mt-px shrink-0 ${TONE[meta.tone].text}`} />}
                {e}
              </li>
            ))}
          </ul>
          <div className="h-px bg-line" />
          <div className="flex items-center gap-2.5">
            <AdviceTag advice={a.advice} />
            <span className="text-xs text-fg-2">{ADVICE_META[a.advice].explain}</span>
          </div>
        </div>
        <Coverage snap={snap} counted={counted} />
      </div>

      {/* stat cards: worst tile, never averaged */}
      <div className="grid grid-cols-5 gap-3">
        <Stat label="卡顿率 · 最差" value={a.worst.rebuffer ? (a.worst.rebuffer.value * 100).toFixed(1) : "—"} unit="%" sub={a.worst.rebuffer ? `${a.worst.rebuffer.tile} · 30 秒` : "暂无可计数的播放"} tone={toneFor(a.worst.rebuffer?.value ?? null, 0.005, 0.02)} values={series.rebuffer} />
        <Stat label="最长中断" value={a.worst.longestStall ? a.worst.longestStall.value.toFixed(1) : "—"} unit="s" sub={a.worst.longestStall ? a.worst.longestStall.tile : "—"} tone={toneFor(a.worst.longestStall?.value ?? null, 0.5, 1)} values={series.stall} />
        <Stat
          label="掉帧率 · 最差"
          value={a.worst.dropRatio ? (a.worst.dropRatio.value * 100).toFixed(1) : "—"}
          unit="%"
          sub={`${a.worst.dropRatio ? a.worst.dropRatio.tile : "无可用计数"} · ${snap.coverage.frames[0]}/${snap.coverage.frames[1]} 路可测`}
          tone={toneFor(a.worst.dropRatio?.value ?? null, 0.005, 0.01)}
          values={series.drops}
        />
        <Stat label="界面延迟 p95" value={snap.device.uiDelayP95 === null ? "—" : String(Math.round(snap.device.uiDelayP95))} unit="ms" sub="主线程调度" tone={toneFor(snap.device.uiDelayP95, 25, 50)} values={series.ui} />
        <Stat
          label="下行 · 网络边界"
          value={snap.network.mbps === null ? "—" : snap.network.mbps.toFixed(1)}
          unit="Mbps"
          sub={snap.network.uncovered.length ? `${snap.network.uncovered.length} 路未覆盖` : "每个连接只计一次"}
          tone={snap.network.mbps === null ? "unknown" : "observe"}
          values={series.net}
        />
      </div>

      <Timeline snap={snap} />

      <div className="flex items-start gap-3">
        <TileTable snap={snap} />
        <Events events={snap.events} />
      </div>
    </>
  );
}

function toneFor(v: number | null, warn: number, bad: number): Tone {
  if (v === null) return "unknown";
  return v >= bad ? "bad" : v >= warn ? "warn" : "good";
}

function Stat({ label, value, unit, sub, tone, values }: { label: string; value: string; unit: string; sub: string; tone: Tone; values: (number | null)[] }) {
  return (
    <div className={`${card} flex flex-col gap-1.5 p-3.5`}>
      <div className="flex items-center">
        <span className={cap}>{label}</span>
        <span className="flex-1" />
        <span className={`size-[7px] rounded-full ${TONE[tone].dot}`} />
      </div>
      <div className="flex items-end gap-1">
        <span className={`font-mono text-2xl font-semibold ${tone === "good" || tone === "observe" ? "text-fg" : TONE[tone].text}`}>{value}</span>
        <span className="pb-1 text-xs text-fg-3">{unit}</span>
      </div>
      <div className="truncate text-[11px] text-fg-2">{sub}</div>
      <Sparkline values={values} tone={tone === "good" ? "observe" : tone} min={0} />
    </div>
  );
}

function Coverage({ snap, counted }: { snap: MonitorSnapshot; counted: number }) {
  const rows: [string, string, Tone, string?][] = [
    ["缓冲与卡顿", `${snap.coverage.buffer[0]} / ${snap.coverage.buffer[1]}`, snap.coverage.buffer[0] === counted ? "good" : "warn"],
    ["帧计数", `${snap.coverage.frames[0]} / ${snap.coverage.frames[1]}`, snap.coverage.frames[0] === counted ? "good" : "warn", snap.coverage.frames[0] < counted ? "部分画面不支持" : undefined],
    ["传输 · 本地中转", `${snap.coverage.relay} 路 FLV`, "good"],
    ["传输 · HLS", `${snap.coverage.hls} 路`, "good"],
    ["本机指标", snap.coverage.native ? "CPU" : "不可用", snap.coverage.native ? "good" : "unknown", "无 GPU / 视频引擎数据"]
  ];
  return (
    <div className={`${card} flex w-[380px] shrink-0 flex-col gap-2.5`}>
      <div className={cap}>覆盖范围</div>
      {rows.map(([k, v, tone, note]) => (
        <div key={k} className="flex items-center gap-2 text-xs">
          <span className={`size-1.5 rounded-full ${TONE[tone].dot}`} />
          <span className="text-fg-2">{k}</span>
          <span className="flex-1" />
          {note ? <span className="text-[10px] text-fg-3">{note}</span> : null}
          <span className="font-mono text-[11px] font-semibold">{v}</span>
        </div>
      ))}
      <div className="text-[11px] text-fg-3">不显示容量数字：播放正常不代表还有剩余带宽或解码余量。</div>
    </div>
  );
}

const LANE: Record<string, { cls: string; thin?: boolean }> = {
  playing: { cls: "bg-online/40", thin: true },
  stall: { cls: "bg-live" },
  buffering: { cls: "bg-live" },
  reconnecting: { cls: "bg-replay" },
  connecting: { cls: "bg-accent" },
  hidden: { cls: "bg-fg-3/35" },
  paused: { cls: "bg-fg-3/35" },
  offline: { cls: "bg-chip" },
  error: { cls: "bg-live/70" }
};

function Timeline({ snap }: { snap: MonitorSnapshot }) {
  const from = snap.now - HISTORY_MS;
  const x = (t: number) => `${Math.max(0, ((t - from) / HISTORY_MS) * 100)}%`;
  const w = (a: number, b: number) => `${Math.max(0.25, ((Math.min(b, snap.now) - Math.max(a, from)) / HISTORY_MS) * 100)}%`;
  const legend: [string, string][] = [
    ["bg-online/40", "播放"],
    ["bg-live", "缓冲 / 卡顿"],
    ["bg-replay", "重连"],
    ["bg-accent", "连接中"],
    ["bg-fg-3/35", "隐藏 / 暂停（不计入）"]
  ];
  return (
    <div className={`${card} flex flex-col gap-2`}>
      <div className="flex items-center gap-3.5">
        <span className={cap}>画面状态 · 最近 5 分钟</span>
        <span className="flex-1" />
        {legend.map(([c, l]) => (
          <span key={l} className="flex items-center gap-1.5 text-[11px] text-fg-2">
            <span className={`h-2 w-2.5 rounded-sm ${c}`} />
            {l}
          </span>
        ))}
      </div>
      {snap.tiles.map((t) => (
        <div key={t.id} className="flex items-center gap-2.5">
          <div className="flex w-[150px] shrink-0 items-center gap-1.5 truncate text-[11px] font-semibold text-fg-2">
            <PlatformMark platform={t.platform as UiPlatform} size={14} />
            <span className="truncate">{t.label}</span>
          </div>
          <div className="relative h-3.5 flex-1 overflow-hidden rounded bg-raised">
            {t.timeline
              .filter((r) => r.to >= from)
              .map((r, i) => {
                const lane = LANE[r.lifecycle] ?? LANE.offline;
                return <span key={i} className={`absolute rounded-sm ${lane.cls} ${lane.thin ? "top-[3px] h-2" : "top-0 h-full"}`} style={{ left: x(r.from), width: w(r.from, r.to) }} />;
              })}
          </div>
        </div>
      ))}
      <div className="flex gap-2.5">
        <span className="w-[150px] shrink-0" />
        <div className="flex flex-1 justify-between font-mono text-[10px] text-fg-3">
          {["−5:00", "−4:00", "−3:00", "−2:00", "−1:00", "现在"].map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function TileTable({ snap }: { snap: MonitorSnapshot }) {
  const order = { warning: 0, observing: 1, unknown: 2, healthy: 3, excluded: 4 } as const;
  const rows = [...snap.assessment.tiles].sort((x, y) => order[x.health] - order[y.health]);
  const th = `${cap} text-left font-bold`;
  return (
    <div className={`${card} min-w-0 flex-1 overflow-x-auto`}>
      <table className="w-full border-separate border-spacing-y-0.5 text-xs">
        <thead>
          <tr>
            {["画面", "状态", "实际", "缓冲", "掉帧", "卡顿率", "最长", "下行", "说明"].map((h) => (
              <th key={h} className={`${th} px-1.5 pb-1.5`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const v = snap.tiles.find((x) => x.id === t.id);
            const h = TILE_HEALTH[t.health];
            const mx = t.metrics;
            const draining = mx.bufferSlope !== null && mx.bufferSlope < -0.05;
            const mono = "px-1.5 py-1.5 font-mono text-[11px] whitespace-nowrap";
            return (
              <tr key={t.id} className={t.health === "warning" ? "bg-live/10" : ""}>
                <td className="rounded-l-lg px-1.5 py-1.5">
                  <span className="flex items-center gap-1.5 font-semibold">
                    {v ? <PlatformMark platform={v.platform as UiPlatform} size={16} /> : null}
                    <span className="max-w-[140px] truncate">{v?.label ?? t.id}</span>
                  </span>
                </td>
                <td className="px-1.5">
                  <Pill tone={t.lifecycle === "buffering" ? "bad" : h.tone}>{t.lifecycle === "buffering" ? "缓冲中" : t.detail === "重连中" ? "重连中" : h.label}</Pill>
                </td>
                <td className={`${mono} text-fg-2`}>{v ? fmt.profile(v.profile, v.transport) : "—"}</td>
                <td className={`${mono} ${mx.bufferAhead !== null && mx.bufferAhead < 1 ? "text-replay" : ""}`}>
                  {mx.bufferAhead === null ? "—" : `${mx.bufferAhead.toFixed(1)} s${draining ? "↓" : ""}`}
                </td>
                <td className={`${mono} ${mx.dropRatio === null ? "text-fg-3" : ""}`}>{fmt.pct(mx.dropRatio)}</td>
                <td className={`${mono} ${mx.rebufferRatio && mx.rebufferRatio > 0.02 ? "text-live" : ""}`}>{fmt.pct(mx.rebufferRatio)}</td>
                <td className={`${mono} ${mx.longestStallS && mx.longestStallS >= 1 ? "text-replay" : ""}`}>{fmt.s(mx.longestStallS)}</td>
                <td className={mono}>{fmt.mbps(mx.rxMbps)}</td>
                <td className="max-w-[260px] truncate rounded-r-lg px-1.5 text-fg-2">{t.excludedReason ? `${t.detail}` : t.detail}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Events({ events }: { events: MonitorEvent[] }) {
  return (
    <div className={`${card} flex w-[330px] shrink-0 flex-col gap-2`}>
      <div className={cap}>事件</div>
      {events.length === 0 ? <div className="text-xs text-fg-3">暂无</div> : null}
      {events.slice(0, 14).map((e, i) => (
        <div key={i} className="flex items-start gap-2 text-[11px]">
          <span className="shrink-0 font-mono text-[10px] text-fg-3">{new Date(e.at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
          <span className={`mt-1 size-1.5 shrink-0 rounded-full ${TONE[e.tone].dot}`} />
          <span className="text-fg-2">{e.text}</span>
        </div>
      ))}
    </div>
  );
}
