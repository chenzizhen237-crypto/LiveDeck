// Split view (Nib: Desktop 11–17). A full-window grid of rooms over the channel
// page, with the island above it and a floating toolbar below.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { LayoutGrid, MessageSquareText, Minimize2, MoveDiagonal2, Plus, Scan, Volume2 } from "lucide-react";

import { Kbd, PlatformMark } from "@/components/livedeck/primitives";
import { applyDanmuFontFamilyForOS } from "@/components/player/constants";
import { usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";
import { useSplit, type PickTarget } from "@/state/split/SplitProvider";
import type { Rect } from "@/state/split/layout";
import { AddRoomPopover } from "./AddRoomPopover";
import { LayoutPicker } from "./LayoutPicker";
import { SplitTile } from "./SplitTile";

const GAP = 6;
const area = (r: Rect) => ({ gridColumn: `${r.col + 1} / span ${r.colSpan}`, gridRow: `${r.row + 1} / span ${r.rowSpan}` });

/** Bigger grids ask for lighter streams: 16 originals would saturate most connections. */
function qualityFor(tileCount: number, platform: string) {
  if (tileCount > 6) return "标清";
  if (tileCount > 2) return "高清";
  try {
    // Same key the single player saves its choice under.
    return window.localStorage.getItem(`${platform.toUpperCase()}_preferred_quality`) || "原画";
  } catch {
    return "原画";
  }
}

type Drag =
  | { kind: "span"; id: string; rect: Rect; ok: boolean }
  | { kind: "move"; id: string; cell: { col: number; row: number } | null; overId: string | null };

export function SplitView() {
  const split = useSplit();
  const overlay = usePlayerOverlay();
  const gridRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [panel, setPanel] = useState<null | "layout" | { add: PickTarget }>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const focused = split.tiles.find((t) => t.id === split.focusId) ?? null;
  const hidden = !!split.picking;

  useEffect(() => {
    void applyDanmuFontFamilyForOS().catch(() => {});
  }, []);

  // Esc unwinds one level: picking → popover → zoom → edit mode. It never closes split itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (split.picking) split.cancelPick();
      else if (panel) setPanel(null);
      else if (split.zoomId) split.toggleZoom(split.zoomId);
      else if (editing) setEditing(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, panel, split]);

  const cellAt = useCallback(
    (x: number, y: number) => {
      const el = gridRef.current;
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const cw = (b.width - GAP * (split.cols - 1)) / split.cols;
      const ch = (b.height - GAP * (split.rows - 1)) / split.rows;
      const col = Math.floor((x - b.left) / (cw + GAP));
      const row = Math.floor((y - b.top) / (ch + GAP));
      return { col: Math.max(0, Math.min(split.cols - 1, col)), row: Math.max(0, Math.min(split.rows - 1, row)) };
    },
    [split.cols, split.rows]
  );

  // Corner-drag to span: the tile keeps its top-left cell and grows/shrinks to the pointer.
  const startSpan = useCallback(
    (id: string, e: React.PointerEvent) => {
      const tile = split.tiles.find((t) => t.id === id);
      if (!tile) return;
      e.preventDefault();
      const onMove = (ev: PointerEvent) => {
        const c = cellAt(ev.clientX, ev.clientY);
        if (!c) return;
        const rect: Rect = {
          col: tile.rect.col,
          row: tile.rect.row,
          colSpan: Math.max(1, c.col - tile.rect.col + 1),
          rowSpan: Math.max(1, c.row - tile.rect.row + 1)
        };
        setDrag({ kind: "span", id, rect, ok: split.previewSpan(id, rect) });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        setDrag((d) => {
          if (d?.kind === "span" && d.ok) split.spanTile(d.id, d.rect);
          return null;
        });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
    },
    [cellAt, split]
  );

  // Header-drag (edit mode): drop on a tile to swap, on an empty cell to move.
  const startMove = useCallback(
    (id: string, e: React.PointerEvent) => {
      e.preventDefault();
      const onMove = (ev: PointerEvent) => {
        const c = cellAt(ev.clientX, ev.clientY);
        if (!c) return;
        const over = split.tiles.find(
          (t) => t.id !== id && c.col >= t.rect.col && c.col < t.rect.col + t.rect.colSpan && c.row >= t.rect.row && c.row < t.rect.row + t.rect.rowSpan
        );
        setDrag({ kind: "move", id, cell: c, overId: over?.id ?? null });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        setDrag((d) => {
          if (d?.kind === "move") {
            if (d.overId) split.swap(d.id, d.overId);
            else if (d.cell) split.move(d.id, d.cell);
          }
          return null;
        });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp, { once: true });
    },
    [cellAt, split]
  );

  const exitSplit = () => {
    const room = focused?.room;
    split.close();
    // Keep watching the room that had audio, full window.
    if (room) overlay.openPlayer({ platform: room.platform, roomId: room.roomId });
  };

  const showDanmaku = (id: string) => split.danmakuAll || id === split.focusId;

  return (
    // Video walls read best on dark, whatever the app theme; tokens follow data-theme.
    <div data-theme="dark" className={`fixed inset-0 z-[480] bg-[#070A12] ${hidden ? "pointer-events-none invisible" : ""}`}>
      {/* grid */}
      <div className="absolute inset-x-2.5 top-12 bottom-[72px]">
        <div
          ref={gridRef}
          className="relative grid h-full w-full"
          style={{
            gap: GAP,
            gridTemplateColumns: `repeat(${split.cols}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${split.rows}, minmax(0, 1fr))`
          }}
        >
          {split.emptyCells.map((c) => (
            <button
              key={`e${c.col}-${c.row}`}
              type="button"
              style={area(c)}
              onClick={() => setPanel({ add: { cell: { col: c.col, row: c.row } } })}
              className={`flex min-h-0 flex-col items-center justify-center gap-2 rounded-[10px] border transition-colors ${
                drag?.kind === "move" && drag.cell?.col === c.col && drag.cell?.row === c.row
                  ? "border-accent bg-accent-soft"
                  : "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]"
              }`}
            >
              <span className="grid size-10 place-items-center rounded-full bg-accent-soft text-accent">
                <Plus size={20} />
              </span>
              <span className="text-[13px] font-bold text-white/90">添加直播间</span>
              <span className="flex items-center gap-1.5 text-[11px] text-white/45">
                从关注、已打开的房间或房间号添加
              </span>
            </button>
          ))}

          {split.tiles.map((t) => {
            const zoomed = split.zoomId === t.id;
            const hiddenByZoom = !!split.zoomId && !zoomed;
            return (
              <SplitTile
                key={t.id}
                tile={t}
                quality={qualityFor(split.tiles.length, t.room.platform)}
                focused={t.id === split.focusId}
                danmakuOn={showDanmaku(t.id) && !hiddenByZoom}
                zoomed={zoomed}
                editing={editing}
                dimmed={drag?.kind === "move" && drag.id !== t.id && drag.overId !== t.id}
                onFocus={() => split.focus(t.id)}
                clickFocuses={split.audioFollowsClick}
                onToggleZoom={() => split.toggleZoom(t.id)}
                onReplace={() => setPanel({ add: { replaceTileId: t.id } })}
                onClose={() => split.removeTile(t.id)}
                onGripPointerDown={(e) => startSpan(t.id, e)}
                onHeaderPointerDown={(e) => startMove(t.id, e)}
                style={
                  zoomed
                    ? { gridColumn: "1 / -1", gridRow: "1 / -1", zIndex: 5 }
                    : { ...area(t.rect), visibility: hiddenByZoom ? "hidden" : undefined, outline: drag?.kind === "move" && drag.overId === t.id ? "2px solid var(--ld-accent)" : undefined }
                }
              />
            );
          })}

          {/* edit mode: the cell lattice, so spans read as whole cells */}
          {editing || drag ? (
            <div
              className="pointer-events-none absolute inset-0 grid"
              style={{ gap: GAP, gridTemplateColumns: `repeat(${split.cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${split.rows}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: split.cols * split.rows }, (_, i) => (
                <span key={i} className="rounded-[10px] border border-accent/25 bg-accent/[0.03]" />
              ))}
            </div>
          ) : null}

          {drag?.kind === "span" ? (
            <div
              className={`pointer-events-none relative z-10 rounded-[10px] border-2 ${drag.ok ? "border-accent bg-accent/10" : "border-live bg-live/10"}`}
              style={area(drag.rect)}
            >
              <span
                className={`absolute right-2 bottom-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-extrabold ${
                  drag.ok ? "bg-accent text-on-accent" : "bg-live text-white"
                }`}
              >
                <MoveDiagonal2 size={13} />
                {drag.ok ? `跨 ${drag.rect.rowSpan} × ${drag.rect.colSpan}` : "放不下"}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="absolute inset-x-0 top-2.5 z-[620] flex justify-center">
          <div className="flex items-center gap-2 rounded-full border border-line-strong bg-elevated px-3 py-1.5 text-xs font-semibold text-fg shadow-float">
            拖动右下角跨格 <span className="text-fg-3">·</span> 拖动标题交换位置 <span className="text-fg-3">·</span> <Kbd>esc</Kbd>
            <span className="text-fg-3">完成</span>
          </div>
        </div>
      ) : null}

      {/* toolbar */}
      <div className="absolute inset-x-0 bottom-3.5 flex justify-center">
        <div className="relative flex items-center gap-0.5 rounded-[14px] border border-line-strong bg-elevated p-[5px] text-fg shadow-float backdrop-blur-2xl">
          <ToolButton active={panel === "layout"} onClick={() => setPanel(panel === "layout" ? null : "layout")} icon={<LayoutGrid size={15} />}>
            {split.layoutName}
          </ToolButton>
          <Divider />
          <div className="flex max-w-[220px] items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold">
            <Volume2 size={15} className="shrink-0 text-accent" />
            {focused ? (
              <>
                <PlatformMark platform={focused.room.platform} size={14} />
                <span className="truncate">{focused.room.anchorName || focused.room.roomId}</span>
              </>
            ) : (
              <span className="text-fg-3">无声音</span>
            )}
          </div>
          <Divider />
          <ToolButton active={split.danmakuAll} onClick={() => split.setDanmakuAll(!split.danmakuAll)} icon={<MessageSquareText size={15} />}>
            {split.danmakuAll ? "弹幕：全部" : "弹幕：有声画面"}
          </ToolButton>
          <ToolButton active={editing} onClick={() => setEditing((v) => !v)} icon={<Scan size={15} />}>
            {editing ? "完成" : "调整跨格"}
          </ToolButton>
          <ToolButton onClick={() => setPanel({ add: null })} icon={<Plus size={15} />}>
            添加
          </ToolButton>
          <Divider />
          <ToolButton onClick={exitSplit} icon={<Minimize2 size={15} />}>
            退出分屏
          </ToolButton>

          <AnimatePresence>
            {panel === "layout" ? <LayoutPicker key="layout" onClose={() => setPanel(null)} /> : null}
            {panel && typeof panel === "object" ? (
              <AddRoomPopover key="add" target={panel.add} onClose={() => setPanel(null)} className="absolute bottom-[calc(100%+10px)] left-1/2 -translate-x-1/2" />
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/** Shown over the channel page while the user picks a room for split view. */
export function SplitPickBanner() {
  const split = useSplit();
  if (!split.open || !split.picking) return null;
  return (
    <div className="fixed inset-x-0 bottom-4 z-[650] flex justify-center">
      <div className="flex items-center gap-3 rounded-full border border-focus bg-elevated py-1.5 pr-1.5 pl-4 text-xs font-semibold text-fg shadow-pop backdrop-blur-2xl">
        点一个直播间加入分屏
        <button type="button" onClick={split.cancelPick} className="rounded-full bg-chip px-3 py-1 font-bold text-fg-2 hover:bg-hover">
          返回分屏 <span className="ml-1 text-fg-3">esc</span>
        </button>
      </div>
    </div>
  );
}

function ToolButton({ active, onClick, icon, children }: { active?: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-colors ${
        active ? "bg-accent-soft text-accent" : "hover:bg-hover"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-line-strong" />;
}
