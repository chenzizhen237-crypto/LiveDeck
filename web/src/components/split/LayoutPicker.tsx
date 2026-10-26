import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "framer-motion";
import { ArrowRight, ChevronRight, Copy, Ellipsis, LayoutDashboard, Minus, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-react";

import { MAX_DIM, PRESETS, type Rect } from "@/state/split/layout";
import { summary, type SavedSetup } from "@/state/split/setups";
import { useSplit } from "@/state/split/SplitProvider";

type MiniShape = { cols: number; rows: number; slots: Rect[] };

export type PanelNotice = { kind: "arranged" | "deleted" | "saved" | "error"; message: string; undo?: () => void };

function Mini({ preset, on, size = "md" }: { preset: MiniShape; on: boolean; size?: "sm" | "md" }) {
  return (
    <div
      className={`grid gap-[2px] ${size === "sm" ? "h-[20px] w-[28px]" : "h-[38px] w-[60px]"}`}
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

const shapeOf = (s: SavedSetup): MiniShape => ({ cols: s.cols, rows: s.rows, slots: s.tiles.map((t) => t.rect) });

function SetupRow({
  setup,
  current,
  onOpen,
  onNotice
}: {
  setup: SavedSetup;
  current: boolean;
  onOpen: () => void;
  onNotice: (n: PanelNotice) => void;
}) {
  const split = useSplit();
  // Menu position (viewport coords). It renders in a portal: the list scrolls (would clip it) and
  // the panel animates with a transform (would re-anchor a fixed child).
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(setup.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const item = "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-left text-xs font-semibold hover:bg-hover";
  return (
    <div className="group relative">
      <div
        role="button"
        tabIndex={0}
        onClick={() => !renaming && onOpen()}
        onKeyDown={(e) => e.key === "Enter" && !renaming && onOpen()}
        className={`flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] border px-2.5 py-2 text-left transition-colors ${
          current ? "border-accent bg-selected" : "border-transparent hover:bg-hover"
        }`}
      >
        <span className="rounded-md bg-white/[0.04] p-1">
          <Mini preset={shapeOf(setup)} on={false} size="sm" />
        </span>
        <span className="min-w-0 flex-1">
          {renaming ? (
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => {
                split.renameSetup(setup.id, name);
                setRenaming(false);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  e.preventDefault();
                  setName(setup.name);
                  setRenaming(false);
                }
              }}
              className="w-full rounded-md bg-chip px-1.5 py-0.5 text-[13px] font-bold text-fg outline-none ring-1 ring-focus"
            />
          ) : (
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-bold text-fg">{setup.name}</span>
              {current ? <span className="rounded-[5px] bg-accent px-1.5 text-[9px] leading-4 font-extrabold text-on-accent">{split.dirty ? "已修改" : "当前"}</span> : null}
            </span>
          )}
          <span className="block truncate text-[11px] font-medium text-fg-3">{summary(setup)}</span>
        </span>
        <button
          type="button"
          aria-label="方案菜单"
          onClick={(e) => {
            e.stopPropagation();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setMenu((v) => (v ? null : { top: r.top, left: r.right + 8 }));
          }}
          className={`grid size-[26px] place-items-center rounded-lg text-fg-2 transition-opacity hover:bg-chip ${menu ? "bg-chip opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        >
          <Ellipsis size={15} />
        </button>
        <ChevronRight size={14} className={`group-hover:hidden ${current ? "text-accent" : "text-fg-3"} ${menu ? "hidden" : ""}`} />
      </div>

      {createPortal(
      <AnimatePresence>
        {menu ? (
          <div data-theme="dark" className="contents">
            <button type="button" aria-label="关闭菜单" className="fixed inset-0 z-[690] cursor-default" onClick={() => setMenu(null)} />
            <m.div
              style={{ top: Math.min(menu.top, window.innerHeight - 220), left: menu.left }}
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.12 }}
              className="fixed z-[695] flex w-[200px] flex-col gap-px rounded-xl border border-line-strong bg-elevated p-[5px] text-fg shadow-pop"
            >
              <button type="button" className={item} onClick={() => (setMenu(null), onOpen())}>
                <Play size={14} className="text-fg-2" /> 打开
              </button>
              <button
                type="button"
                className={item}
                onClick={() => {
                  setMenu(null);
                  split.updateSetup(setup.id);
                  onNotice({ kind: "saved", message: `已用当前画面更新「${setup.name}」` });
                }}
              >
                <RefreshCw size={14} className="text-fg-2" /> 用当前画面更新
              </button>
              <button type="button" className={item} onClick={() => (setMenu(null), setName(setup.name), setRenaming(true))}>
                <Pencil size={14} className="text-fg-2" /> 重命名
              </button>
              <button
                type="button"
                className={item}
                onClick={() => {
                  setMenu(null);
                  const copy = split.duplicateSetup(setup.id);
                  if (copy) onNotice({ kind: "saved", message: `已复制为「${copy.name}」` });
                }}
              >
                <Copy size={14} className="text-fg-2" /> 复制
              </button>
              <span className="my-0.5 h-px bg-line" />
              <button
                type="button"
                className={`${item} text-live`}
                onClick={() => {
                  setMenu(null);
                  const undo = split.deleteSetup(setup.id);
                  if (undo) onNotice({ kind: "deleted", message: `已删除「${setup.name}」`, undo });
                }}
              >
                <Trash2 size={14} /> 删除
              </button>
            </m.div>
          </div>
        ) : null}
      </AnimatePresence>,
      document.body
      )}
    </div>
  );
}

export function LayoutPicker({
  onClose,
  gridAspect,
  onRequestSave,
  onNotice,
  positionClass = "bottom-[calc(100%+10px)] left-0"
}: {
  onClose: () => void;
  /** Where it opens relative to the toolbar (it follows the toolbar when that's moved). */
  positionClass?: string;
  /** Width / height of the grid area, for Auto Arrange. */
  gridAspect: number;
  onRequestSave: () => void;
  onNotice: (n: PanelNotice) => void;
}) {
  const split = useSplit();
  const [tab, setTab] = useState<"templates" | "mine">(split.currentSetup ? "mine" : "templates");
  const [hoverCell, setHoverCell] = useState<{ cols: number; rows: number } | null>(null);
  const shown = hoverCell ?? { cols: split.cols, rows: split.rows };
  const n = split.tiles.length;
  const shownFits = shown.cols * shown.rows >= n;
  const arrangePreview = split.previewArrange(gridAspect);

  const tabBtn = (id: "templates" | "mine", label: string) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={`flex-1 rounded-lg py-1.5 text-xs transition-colors ${tab === id ? "bg-white/[0.12] font-bold text-fg shadow-sm" : "font-semibold text-fg-2 hover:text-fg"}`}
    >
      {label}
    </button>
  );

  return (
    <>
      <button type="button" aria-label="关闭布局" className="fixed inset-0 z-0 cursor-default" onClick={onClose} />
      <m.div
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={{ duration: 0.16 }}
        className={`absolute ${positionClass} z-10 flex max-h-[calc(100vh-120px)] w-[340px] flex-col gap-3 overflow-y-auto rounded-2xl border border-line-strong bg-elevated p-4 shadow-pop backdrop-blur-2xl`}
      >
        <div className="flex items-center">
          <span className="text-sm font-bold text-fg">布局</span>
          <span className="flex-1" />
          <span className="text-[11px] font-semibold text-fg-3">
            {n} 个直播间 · {split.layoutName}
          </span>
        </div>

        <button
          type="button"
          disabled={!arrangePreview}
          onClick={() => {
            const a = split.arrange(gridAspect);
            if (a) {
              onNotice({ kind: "arranged", message: `已排列为 ${a.rows} 行 × ${a.cols} 列`, undo: split.undoLayout });
              onClose();
            }
          }}
          className="flex items-center gap-2.5 rounded-xl border border-accent bg-accent-soft px-3 py-2.5 text-left transition-opacity disabled:border-line disabled:bg-hover disabled:opacity-60"
        >
          <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-accent text-on-accent">
            <LayoutDashboard size={16} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-bold text-fg">自动排列</span>
            <span className="block truncate text-[11px] font-medium text-fg-2">{arrangePreview ? "收紧空位，保留主画面和顺序" : "已经很紧凑了"}</span>
          </span>
          {arrangePreview ? (
            <span className="flex shrink-0 items-center gap-1">
              <Mini preset={{ cols: split.cols, rows: split.rows, slots: split.tiles.map((t) => t.rect) }} on={false} size="sm" />
              <ArrowRight size={12} className="text-accent" />
              <Mini preset={{ cols: arrangePreview.cols, rows: arrangePreview.rows, slots: arrangePreview.tiles.map((t) => t.rect) }} on size="sm" />
            </span>
          ) : null}
        </button>

        <div className="flex gap-0.5 rounded-[10px] bg-chip p-[3px]">
          {tabBtn("templates", "布局模板")}
          {tabBtn("mine", "我的方案")}
        </div>

        {tab === "templates" ? (
          <>
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
              </div>
            </div>
          </>
        ) : (
          <>
            {split.setups.length ? (
              <div className="-mx-1 flex max-h-[300px] flex-col gap-0.5 overflow-y-auto px-1">
                {split.setups.map((x) => (
                  <SetupRow
                    key={x.id}
                    setup={x}
                    current={x.id === split.currentSetup?.id}
                    onNotice={onNotice}
                    onOpen={() => {
                      const r = split.openSetup(x.id);
                      if (r === "too-small") onNotice({ kind: "error", message: `「${x.name}」只有 ${x.tiles.length} 格，放不下 ${n} 个直播间` });
                    }}
                  />
                ))}
              </div>
            ) : (
              <p className="px-1 text-xs leading-relaxed text-fg-3">还没有保存的方案。把房间、布局和声音设置存成方案，下次一键打开。</p>
            )}
            <button
              type="button"
              onClick={onRequestSave}
              className="flex items-center justify-center gap-1.5 rounded-[10px] bg-chip py-2 text-xs font-bold text-fg hover:bg-hover"
            >
              <Plus size={14} /> 保存当前方案
            </button>
          </>
        )}

        <div className="h-px bg-line" />
        <Toggle label="点击画面切换声音" on={split.audioFollowsClick} onChange={split.setAudioFollowsClick} />
        <Toggle label="所有画面显示弹幕" on={split.danmakuAll} onChange={split.setDanmakuAll} />
      </m.div>
    </>
  );
}
