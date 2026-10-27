// Shared presentation for playback health: icons, colours and copy for each
// state and advice. Colour is never the only signal; every state has an icon
// and words too.

import React from "react";
import { CircleCheck, CircleHelp, CloudAlert, Cpu, Hourglass, LoaderCircle, MonitorX, Plus, TriangleAlert } from "lucide-react";

import type { Advice, SystemState, TileHealth } from "@/services/playbackMetrics/model";

export type Tone = "good" | "warn" | "bad" | "observe" | "unknown";

/** text / soft background / border classes per tone (theme tokens: online, replay, live, accent, fg-3) */
export const TONE: Record<Tone, { text: string; soft: string; ring: string; dot: string; stroke: string }> = {
  good: { text: "text-online", soft: "bg-online/15", ring: "border-online/70", dot: "bg-online", stroke: "var(--color-online)" },
  warn: { text: "text-replay", soft: "bg-replay/15", ring: "border-replay/70", dot: "bg-replay", stroke: "var(--color-replay)" },
  bad: { text: "text-live", soft: "bg-live/15", ring: "border-live/70", dot: "bg-live", stroke: "var(--color-live)" },
  observe: { text: "text-accent", soft: "bg-accent-soft", ring: "border-accent/60", dot: "bg-accent", stroke: "var(--color-accent)" },
  unknown: { text: "text-fg-3", soft: "bg-chip", ring: "border-line-strong", dot: "bg-fg-3", stroke: "var(--color-fg-3)" }
};

export const STATE_META: Record<SystemState, { tone: Tone; icon: React.ComponentType<{ size?: number; className?: string }>; short: (n: number) => string }> = {
  observing: { tone: "observe", icon: LoaderCircle, short: () => "正在观察…" },
  healthy: { tone: "good", icon: CircleCheck, short: (n) => `${n} 路流畅` },
  delivery: { tone: "warn", icon: CloudAlert, short: () => "传输跟不上" },
  local: { tone: "warn", icon: Cpu, short: () => "设备吃力" },
  isolated: { tone: "warn", icon: MonitorX, short: () => "一路不稳定" },
  unclear: { tone: "bad", icon: CircleHelp, short: () => "不稳定 · 原因不明" }
};

export const ADVICE_META: Record<Advice, { tone: Tone; icon: React.ComponentType<{ size?: number; className?: string }>; label: string; short: string; explain: string }> = {
  try: { tone: "observe", icon: Plus, label: "可以试着再加一路", short: "可再加一路", explain: "当前播放正常，但剩余带宽和解码余量并未得到验证。" },
  likely: { tone: "good", icon: CircleCheck, label: "再加一路大概率可行", short: "可再加一路", explain: "播放正常，最近一次类似的添加也保持稳定。这仍是估计。" },
  wait: { tone: "unknown", icon: Hourglass, label: "先等等", short: "先等等", explain: "刚启动、刚有变化，或数据还不够。" },
  avoid: { tone: "warn", icon: TriangleAlert, label: "暂不建议添加", short: "暂不添加", explain: "现在添加大概率会更糟。不会自动做任何改动。" }
};

export const TILE_HEALTH: Record<TileHealth, { tone: Tone; label: string }> = {
  healthy: { tone: "good", label: "播放中" },
  warning: { tone: "bad", label: "异常" },
  observing: { tone: "observe", label: "稳定中" },
  excluded: { tone: "unknown", label: "不计入" },
  unknown: { tone: "unknown", label: "无数据" }
};

export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${TONE[tone].soft} ${TONE[tone].text}`}>{children}</span>;
}

export function AdviceTag({ advice }: { advice: Advice }) {
  const a = ADVICE_META[advice];
  const Icon = a.icon;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-[3px] text-[11px] font-semibold ${TONE[a.tone].soft} ${a.tone === "unknown" ? "text-fg-2" : TONE[a.tone].text}`}>
      <Icon size={12} className={TONE[a.tone].text} />
      {a.label}
    </span>
  );
}

/** Polyline sparkline in a 100×30 box; null points break the line. */
export function Sparkline({ values, tone, height = 28, min, max }: { values: (number | null)[]; tone: Tone; height?: number; min?: number; max?: number }) {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return <div style={{ height }} className="flex items-center text-[10px] text-fg-3">数据不足</div>;
  const lo = min ?? Math.min(...nums);
  const hi = Math.max(max ?? Math.max(...nums), lo + 1e-6);
  const step = 100 / Math.max(1, values.length - 1);
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    const y = 28 - ((v - lo) / (hi - lo)) * 26;
    d += `${pen ? "L" : "M"}${(i * step).toFixed(2)} ${y.toFixed(2)} `;
    pen = true;
  });
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="block w-full" style={{ height }}>
      <path d={d} fill="none" stroke={TONE[tone].stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export const fmt = {
  pct: (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)} %`),
  s: (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} s`),
  mbps: (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} Mbps`),
  profile: (p: { width: number | null; height: number | null; fps: number | null; codec: string | null }, transport: string) => {
    const res = p.height ? `${p.height}p${p.fps ? p.fps : ""}` : "—";
    const codec = p.codec ? (/^(hvc|hev)/i.test(p.codec) ? "HEVC" : /^avc/i.test(p.codec) ? "H.264" : p.codec.split(".")[0].toUpperCase()) : null;
    return [res, codec, transport.toUpperCase()].filter(Boolean).join(" · ");
  }
};
