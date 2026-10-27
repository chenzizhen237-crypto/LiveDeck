"use client";

// Split toolbar status chip: current playback health + one-step add advice.
// Click for the reason, affected streams, recent buffer and a way into the
// full Playback monitor. Never blocks anything; suggestions only.

import React, { useEffect, useRef } from "react";
import { AnimatePresence, m } from "framer-motion";
import { ChevronDown, Gauge, Info } from "lucide-react";

import { PlatformMark } from "@/components/livedeck/primitives";
import type { UiPlatform } from "@/state/category/CategoryProvider";
import { usePlaybackMonitor, type MonitorSnapshot } from "@/services/playbackMetrics/monitor";

import { ADVICE_META, AdviceTag, Pill, STATE_META, Sparkline, TILE_HEALTH, TONE } from "./health";

export function PlaybackHealthChip({
  open,
  onToggle,
  onOpenMonitor,
  positionClass
}: {
  open: boolean;
  onToggle: () => void;
  onOpenMonitor: () => void;
  /** same placement as the dock's other panels (opens toward the roomier side) */
  positionClass: string;
}) {
  const snap = usePlaybackMonitor();
  if (!snap) return null;
  const a = snap.assessment;
  const meta = STATE_META[a.state];
  const Icon = meta.icon;
  const healthyCount = a.tiles.filter((t) => t.health === "healthy").length;
  const tone = TONE[meta.tone];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={a.headline}
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-[5px] text-xs font-semibold text-fg ${tone.soft} ${tone.ring} hover:brightness-110`}
      >
        <Icon size={14} className={`${tone.text} ${a.state === "observing" ? "animate-spin [animation-duration:2.4s]" : ""}`} />
        <span className="whitespace-nowrap">{meta.short(healthyCount)}</span>
        <span className="size-[3px] rounded-full bg-fg-3" />
        <span className="whitespace-nowrap font-medium text-fg-2">{ADVICE_META[a.advice].short}</span>
        <ChevronDown size={12} className="text-fg-3" />
      </button>
      <AnimatePresence>{open ? <HealthPopover key="pop" snap={snap} onClose={onToggle} onOpenMonitor={onOpenMonitor} positionClass={positionClass} /> : null}</AnimatePresence>
    </div>
  );
}

function HealthPopover({ snap, onClose, onOpenMonitor, positionClass }: { snap: MonitorSnapshot; onClose: () => void; onOpenMonitor: () => void; positionClass: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const a = snap.assessment;
  const meta = STATE_META[a.state];
  const Icon = meta.icon;
  const labelOf = (id: string) => snap.tiles.find((t) => t.id === id);

  // Esc is handled by the host's Esc chain (SplitView), which also stops macOS full-screen exit.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);

  // Worst affected tile's buffer, else the first counted tile.
  const focusId = a.affected[0] ?? a.tiles.find((t) => t.health !== "excluded")?.id;
  const focus = focusId ? labelOf(focusId) : undefined;
  const advice = ADVICE_META[a.advice];

  return (
    <m.div
      ref={ref}
      initial={{ opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 6, scale: 0.98 }}
      transition={{ duration: 0.16 }}
      className={`absolute ${positionClass} z-10 flex w-[400px] flex-col gap-3.5 rounded-2xl border border-line-strong bg-elevated p-[18px] text-fg shadow-pop backdrop-blur-2xl`}
    >
      <div className="flex items-start gap-3">
        <span className={`grid size-9 shrink-0 place-items-center rounded-[10px] ${TONE[meta.tone].soft}`}>
          <Icon size={18} className={TONE[meta.tone].text} />
        </span>
        <div className="min-w-0">
          <div className="text-[15px] font-bold">{a.headline}</div>
          <div className="mt-0.5 text-xs text-fg-2">{a.detail}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-[10px] bg-raised px-2.5 py-2">
        <AdviceTag advice={a.advice} />
        <span className="text-xs text-fg-2">{advice.explain}</span>
      </div>

      {a.affected.length ? (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] font-bold tracking-[0.08em] text-fg-3">受影响的画面</div>
          {a.affected.map((id) => {
            const t = a.tiles.find((x) => x.id === id)!;
            const v = labelOf(id);
            return (
              <div key={id} className="flex items-center gap-2.5 rounded-[10px] bg-raised px-2.5 py-2">
                {v ? <PlatformMark platform={v.platform as UiPlatform} size={18} /> : null}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold">{v?.label ?? id}</div>
                  <div className="truncate text-[11px] text-fg-2">{t.detail}</div>
                </div>
                <Pill tone={t.lifecycle === "buffering" || t.detail === "重连中" ? "bad" : "warn"}>{t.lifecycle === "buffering" ? "缓冲中" : t.detail === "重连中" ? "重连中" : TILE_HEALTH[t.health].label}</Pill>
              </div>
            );
          })}
        </div>
      ) : a.evidence.length ? (
        <ul className="flex flex-col gap-1 text-xs text-fg-2">
          {a.evidence.map((e) => (
            <li key={e}>· {e}</li>
          ))}
        </ul>
      ) : null}

      {focus ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center text-[10px] font-bold tracking-[0.08em] text-fg-3">
            近期 · 前向缓冲 · {focus.label}
            <span className="flex-1" />
            <span className="font-mono font-medium">60 s</span>
          </div>
          <div className="rounded-lg bg-raised px-2 py-1.5">
            <Sparkline values={focus.buffer.map((p) => p.v)} tone={a.affected.length ? "warn" : "observe"} height={40} min={0} />
          </div>
        </div>
      ) : null}

      <div className="flex items-start gap-2 text-[11px] text-fg-3">
        <Info size={13} className="mt-px shrink-0" />
        未验证：你的网络带宽或剩余解码能力。不会自动添加、降画质或关闭画面。
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => {
            onClose();
            onOpenMonitor();
          }}
          className="flex items-center gap-1.5 rounded-full bg-chip px-4 py-1.5 text-xs font-bold text-fg-2 hover:bg-hover"
        >
          <Gauge size={14} />
          打开播放监控
        </button>
      </div>
    </m.div>
  );
}
