// Shared presentation for playback health: icons, colours and copy for each
// state and advice. Colour is never the only signal; every state has an icon
// and words too.

import React from "react";
import { CircleCheck, CircleHelp, CloudAlert, Cpu, Hourglass, LoaderCircle, MonitorX, Plus, TriangleAlert } from "lucide-react";

import { useT, type MsgKey } from "@/i18n";
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

export const STATE_META: Record<SystemState, { tone: Tone; icon: React.ComponentType<{ size?: number; className?: string }>; short: MsgKey }> = {
  observing: { tone: "observe", icon: LoaderCircle, short: "chip.observing" },
  healthy: { tone: "good", icon: CircleCheck, short: "chip.healthy" },
  delivery: { tone: "warn", icon: CloudAlert, short: "chip.delivery" },
  local: { tone: "warn", icon: Cpu, short: "chip.local" },
  isolated: { tone: "warn", icon: MonitorX, short: "chip.isolated" },
  unclear: { tone: "bad", icon: CircleHelp, short: "chip.unclear" }
};

export const ADVICE_META: Record<Advice, { tone: Tone; icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  try: { tone: "observe", icon: Plus },
  likely: { tone: "good", icon: CircleCheck },
  wait: { tone: "unknown", icon: Hourglass },
  avoid: { tone: "warn", icon: TriangleAlert }
};

/** advice.<a>, advice.<a>.short, advice.<a>.explain */
export const adviceKey = (a: Advice, part?: "short" | "explain") => (part ? `advice.${a}.${part}` : `advice.${a}`) as MsgKey;

export const TILE_HEALTH: Record<TileHealth, { tone: Tone; label: MsgKey }> = {
  healthy: { tone: "good", label: "health.healthy" },
  warning: { tone: "bad", label: "health.warning" },
  observing: { tone: "observe", label: "health.observing" },
  excluded: { tone: "unknown", label: "health.excluded" },
  unknown: { tone: "unknown", label: "health.unknown" }
};

export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${TONE[tone].soft} ${TONE[tone].text}`}>{children}</span>;
}

export function AdviceTag({ advice }: { advice: Advice }) {
  const { t } = useT();
  const a = ADVICE_META[advice];
  const Icon = a.icon;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-[3px] text-[11px] font-semibold ${TONE[a.tone].soft} ${a.tone === "unknown" ? "text-fg-2" : TONE[a.tone].text}`}>
      <Icon size={12} className={TONE[a.tone].text} />
      {t(adviceKey(advice))}
    </span>
  );
}

/** Polyline sparkline in a 100×30 box; null points break the line. */
export function Sparkline({ values, tone, height = 28, min, max }: { values: (number | null)[]; tone: Tone; height?: number; min?: number; max?: number }) {
  const { t } = useT();
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return <div style={{ height }} className="flex items-center text-[10px] text-fg-3">{t("spark.insufficient")}</div>;
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
