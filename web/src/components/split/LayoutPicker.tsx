import React, { useState } from "react";
import { m } from "framer-motion";
import { Minus, Plus } from "lucide-react";

import { MAX_DIM, PRESETS, type Preset } from "@/state/split/layout";
import { useSplit } from "@/state/split/SplitProvider";

function Mini({ preset, on }: { preset: Preset; on: boolean }) {
  return (
    <div
      className="grid h-[38px] w-[60px] gap-[2px]"
      style={{ gridTemplateColumns: `repeat(${preset.cols}, 1fr)`, gridTemplateRows: `repeat(${preset.rows}, 1fr)` }}
    >
      {preset.slots.map((s, i) => (
        <span
          key={i}
          className={`rounded-[2px] ${on ? (i === 0 ? "bg-accent" : "bg-accent-soft") : i === 0 ? "bg-fg-3/60" : "bg-fg-3/25"}`}
          style={{ gridColumn: `${s.col + 1} / span ${s.colSpan}`, gridRow: `${s.row + 1} / span ${s.rowSpan}` }}
        />
      ))}
    </div>
  );
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const b = "grid size-6 place-items-center rounded-md text-fg-2 hover:bg-hover disabled:opacity-30";
  return (
    <div className="flex items-center">
      <span className="text-xs font-medium text-fg-2">{label}</span>
      <span className="flex-1" />
      <div className="flex items-center gap-0.5 rounded-lg bg-chip p-0.5">
        <button type="button" className={b} disabled={value <= 1} onClick={() => onChange(value - 1)} aria-label={`减少${label}`}>
          <Minus size={13} />
        </button>
        <span className="w-[22px] text-center text-xs font-bold text-fg">{value}</span>
        <button type="button" className={b} disabled={value >= MAX_DIM} onClick={() => onChange(value + 1)} aria-label={`增加${label}`}>
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className="flex w-full items-center text-left" onClick={() => onChange(!on)}>
      <span className="text-xs font-medium text-fg-2">{label}</span>
      <span className="flex-1" />
      <span className={`flex h-[18px] w-[30px] rounded-full p-0.5 transition-colors ${on ? "justify-end bg-accent" : "justify-start bg-chip"}`}>
        <span className="size-[14px] rounded-full bg-white shadow" />
      </span>
    </button>
  );
}

export function LayoutPicker({ onClose }: { onClose: () => void }) {
  const split = useSplit();
  const [hoverCell, setHoverCell] = useState<{ cols: number; rows: number } | null>(null);
  const shown = hoverCell ?? { cols: split.cols, rows: split.rows };
  const n = split.tiles.length;
  const shownFits = shown.cols * shown.rows >= n;

  return (
    <>
      <button type="button" aria-label="关闭布局" className="fixed inset-0 z-0 cursor-default" onClick={onClose} />
      <m.div
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ duration: 0.16 }}
        className="absolute bottom-[calc(100%+10px)] left-0 z-10 flex w-[340px] flex-col gap-3.5 rounded-2xl border border-line-strong bg-elevated p-4 shadow-pop backdrop-blur-2xl"
      >
        <div className="flex items-center">
          <span className="text-sm font-bold text-fg">布局</span>
          <span className="flex-1" />
          <span className="text-[11px] font-semibold text-fg-3">{n} 个直播间</span>
        </div>

        <span className="text-[10px] font-bold tracking-[0.08em] text-fg-3">预设</span>
        <div className="grid grid-cols-4 gap-1">
          {PRESETS.map((p) => {
            const on = split.layoutName === p.name;
            const fits = p.slots.length >= n;
            return (
              <button
                key={p.name}
                type="button"
                disabled={!fits}
                title={fits ? p.name : `放不下 ${n} 个直播间`}
                onClick={() => split.applyPreset(p.name)}
                className={`flex flex-col items-center gap-1.5 rounded-[10px] border p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                  on ? "border-accent bg-selected" : "border-transparent hover:bg-hover"
                }`}
              >
                <Mini preset={p} on={on} />
                <span className={`text-[11px] font-semibold ${on ? "text-accent" : "text-fg-2"}`}>{p.name}</span>
              </button>
            );
          })}
        </div>

        <div className="h-px bg-line" />

        <div className="flex items-center">
          <span className="text-[10px] font-bold tracking-[0.08em] text-fg-3">自定义网格</span>
          <span className="flex-1" />
          <span className="text-xs font-bold text-accent">
            {shown.rows} × {shown.cols}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="grid grid-cols-4 gap-[3px]" onPointerLeave={() => setHoverCell(null)}>
            {Array.from({ length: MAX_DIM * MAX_DIM }, (_, i) => {
              const c = (i % MAX_DIM) + 1;
              const r = Math.floor(i / MAX_DIM) + 1;
              const lit = c <= shown.cols && r <= shown.rows;
              const fits = c * r >= n;
              return (
                <button
                  key={i}
                  type="button"
                  aria-label={`${r} × ${c}`}
                  disabled={!fits}
                  onPointerEnter={() => setHoverCell({ cols: c, rows: r })}
                  onClick={() => split.setGrid(c, r)}
                  className={`size-[22px] rounded-[5px] border transition-colors disabled:cursor-not-allowed ${
                    lit ? (shownFits ? "border-accent bg-accent-soft" : "border-live/60 bg-live/15") : "border-line bg-hover"
                  }`}
                />
              );
            })}
          </div>
          <div className="flex flex-1 flex-col gap-2.5">
            <Stepper label="行" value={split.rows} onChange={(v) => split.setGrid(split.cols, v)} />
            <Stepper label="列" value={split.cols} onChange={(v) => split.setGrid(v, split.rows)} />
            <p className="text-[11px] leading-snug text-fg-3">最多 4 × 4。拖动画面右下角可跨越多个格子。</p>
          </div>
        </div>

        <div className="h-px bg-line" />
        <Toggle label="点击画面切换声音" on={split.audioFollowsClick} onChange={split.setAudioFollowsClick} />
        <Toggle label="所有画面显示弹幕" on={split.danmakuAll} onChange={split.setDanmakuAll} />
      </m.div>
    </>
  );
}
