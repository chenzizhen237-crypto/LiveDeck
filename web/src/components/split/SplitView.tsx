// Split view (Nib: Desktop 11–17). A full-window grid of rooms over the channel
// page, with the island above it and a floating toolbar below.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { Check, LayoutDashboard, LayoutGrid, MessageSquareText, Minimize2, MoveDiagonal2, Plus, Scan, Trash2, TriangleAlert, Volume2 } from "lucide-react";

import { PlatformMark } from "@/components/livedeck/primitives";
import { applyDanmuFontFamilyForOS } from "@/components/player/constants";
import { usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";
import { useSplit, type PickTarget } from "@/state/split/SplitProvider";
import { rectFromHandle, type Rect } from "@/state/split/layout";
import { AddRoomPopover } from "./AddRoomPopover";
import { LayoutPicker, type PanelNotice } from "./LayoutPicker";
import { SaveSetupDialog } from "./SaveSetupDialog";
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

type Cell = { col: number; row: number };
type Drag =
  | { kind: "span"; id: string; rect: Rect; ok: boolean }
  // Move: `rect` is where it lands (null = nowhere); `overId` set means a swap.
  | { kind: "move"; id: string; rect: Rect | null; overId: string | null };

const DRAG_THRESHOLD_PX = 6;

export function SplitView() {
  const split = useSplit();
  const overlay = usePlayerOverlay();
  const gridRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [panel, setPanel] = useState<null | "layout" | { add: PickTarget }>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragAbort = useRef<null | (() => void)>(null);
  const [notice, setNotice] = useState<PanelNotice | null>(null);
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const noticeTimer = useRef(0);

  const notify = useCallback((n: PanelNotice) => {
    setNotice(n);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), n.undo ? 6000 : 3000);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const gridAspect = () => {
    const b = gridRef.current?.getBoundingClientRect();
    return b && b.height > 0 ? b.width / b.height : 16 / 9;
  };
  const focused = split.tiles.find((t) => t.id === split.focusId) ?? null;
  const hidden = !!split.picking;

  useEffect(() => {
    void applyDanmuFontFamilyForOS().catch(() => {});
  }, []);

  // Esc unwinds one level: drag → picking → popover → zoom → edit mode. It never closes split
  // itself. Handled presses call preventDefault: in a macOS full-screen window an Esc the page
  // leaves unhandled goes up to AppKit, which exits full screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (saveAs !== null) return; // the dialog handles its own Esc
      if (dragAbort.current) dragAbort.current();
      else if (split.picking) split.cancelPick();
      else if (panel) setPanel(null);
      else if (split.zoomId) split.toggleZoom(split.zoomId);
      else if (editing) setEditing(false);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editing, panel, saveAs, split]);

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

  /** Runs a pointer drag: `onMove` per move, `onDrop` on release; Esc cancels. */
  const runDrag = useCallback((onMove: (c: Cell, ev: PointerEvent) => void, onDrop: () => void) => {
    const move = (ev: PointerEvent) => {
      const c = cellAt(ev.clientX, ev.clientY);
      if (c) onMove(c, ev);
    };
    const end = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      dragAbort.current = null;
      if (commit) onDrop();
      setDrag(null);
    };
    const up = () => end(true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    dragAbort.current = () => end(false);
  }, [cellAt]);

  // Resize from any corner/edge: the opposite sides stay where they are.
  const startResize = useCallback(
    (id: string, handle: string, e: React.PointerEvent) => {
      const tile = split.tiles.find((t) => t.id === id);
      if (!tile || e.button !== 0) return;
      e.preventDefault();
      let latest: Drag | null = null;
      runDrag(
        (c) => {
          const rect = rectFromHandle(tile.rect, handle, c);
          latest = { kind: "span", id, rect, ok: split.previewSpan(id, rect) };
          setDrag(latest);
        },
        () => {
          if (latest?.kind === "span" && latest.ok) split.spanTile(latest.id, latest.rect);
        }
      );
    },
    [runDrag, split]
  );

  // Drag a tile: onto another tile swaps them; onto free space moves it, keeping its span
  // where it fits (anchored where you grabbed it), else as one cell under the pointer.
  const startDrag = useCallback(
    (id: string, e: React.PointerEvent) => {
      const tile = split.tiles.find((t) => t.id === id);
      if (!tile || e.button !== 0 || split.zoomId) return;
      const grab = cellAt(e.clientX, e.clientY);
      if (!grab) return;
      const offset = { col: grab.col - tile.rect.col, row: grab.row - tile.rect.row };
      const start = { x: e.clientX, y: e.clientY };
      let started = false;
      let latest: Drag | null = null;
      // The inputs behind the latest preview, so the drop lands exactly where the ghost was.
      let moveArgs: { topLeft: Cell; pointer: Cell } | null = null;
      runDrag(
        (c, ev) => {
          if (!started) {
            if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD_PX) return;
            started = true;
          }
          const over = split.tiles.find(
            (t) => t.id !== id && c.col >= t.rect.col && c.col < t.rect.col + t.rect.colSpan && c.row >= t.rect.row && c.row < t.rect.row + t.rect.rowSpan
          );
          moveArgs = over ? null : { topLeft: { col: c.col - offset.col, row: c.row - offset.row }, pointer: c };
          latest = over
            ? { kind: "move", id, rect: over.rect, overId: over.id }
            : { kind: "move", id, rect: split.previewMove(id, moveArgs!.topLeft, c), overId: null };
          setDrag(latest);
        },
        () => {
          if (latest?.kind !== "move") return;
          if (latest.overId) split.swap(latest.id, latest.overId);
          else if (latest.rect && moveArgs) split.move(latest.id, moveArgs.topLeft, moveArgs.pointer);
        }
      );
    },
    [cellAt, runDrag, split]
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
                "border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/[0.06]"
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
                dimmed={false}
                dragging={drag?.kind === "move" && drag.id === t.id}
                onFocus={() => split.focus(t.id)}
                clickFocuses={split.audioFollowsClick}
                onToggleZoom={() => split.toggleZoom(t.id)}
                onReplace={() => setPanel({ add: { replaceTileId: t.id } })}
                onClose={() => split.removeTile(t.id)}
                onResizePointerDown={(e, handle) => startResize(t.id, handle, e)}
                onDragPointerDown={(e) => startDrag(t.id, e)}
                style={
                  zoomed
                    ? { gridColumn: "1 / -1", gridRow: "1 / -1", zIndex: 5 }
                    : { ...area(t.rect), visibility: hiddenByZoom ? "hidden" : undefined }
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

          {drag?.kind === "move" && drag.rect ? (
            <div
              className="pointer-events-none relative z-10 flex items-end justify-start rounded-[10px] border-2 border-accent bg-accent/15 p-2.5"
              style={area(drag.rect)}
            >
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-extrabold text-on-accent">
                {drag.overId ? "交换位置" : "移到这里"}
              </span>
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

      {/* above the toolbar: notices (with undo), unsaved-changes bar, edit-mode hint */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[66px] z-[20] flex flex-col items-center gap-2">
        <AnimatePresence>
          {notice && panel !== "layout" ? <NoticeToast key={notice.message} notice={notice} onDismiss={() => setNotice(null)} /> : null}
        </AnimatePresence>
        {split.currentSetup && split.dirty && !editing ? (
          <div className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-line-strong bg-elevated py-1.5 pr-1.5 pl-3.5 text-xs text-fg shadow-float">
            <span className="size-[7px] rounded-full bg-replay" />
            <span className="font-bold">{split.currentSetup.name}</span>
            <span className="text-fg-3">· 未保存的更改</span>
            <button type="button" onClick={() => setSaveAs(`${split.currentSetup!.name} 副本`)} className="rounded-full bg-chip px-3 py-1 font-bold hover:bg-hover">
              另存为
            </button>
            <button
              type="button"
              onClick={() => {
                split.updateSetup(split.currentSetup!.id);
                notify({ kind: "saved", message: `已保存「${split.currentSetup!.name}」` });
              }}
              className="rounded-full bg-accent px-3 py-1 font-bold text-on-accent"
            >
              保存更改
            </button>
          </div>
        ) : null}
        {editing ? (
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-line-strong bg-elevated py-1 pr-1 pl-3 text-xs font-semibold text-fg shadow-float">
            拖动画面移动或交换 <span className="text-fg-3">·</span> 拖动四边或四角跨格
            <button type="button" onClick={() => setEditing(false)} className="rounded-full bg-accent px-3 py-1 font-bold text-on-accent">
              完成
            </button>
          </div>
        ) : null}
      </div>

      {/* while the layout panel is open its notices show at the top, clear of the panel */}
      {notice && panel === "layout" ? (
        <div className="pointer-events-none absolute inset-x-0 top-14 z-[20] flex justify-center">
          <NoticeToast notice={notice} onDismiss={() => setNotice(null)} />
        </div>
      ) : null}

      {saveAs !== null ? (
        <SaveSetupDialog initialName={saveAs} onClose={() => setSaveAs(null)} onSaved={(name) => notify({ kind: "saved", message: `已保存「${name}」` })} />
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
            {panel === "layout" ? (
              <LayoutPicker
                key="layout"
                onClose={() => setPanel(null)}
                gridAspect={gridAspect()}
                onNotice={notify}
                onRequestSave={() => {
                  setPanel(null);
                  setSaveAs(split.currentSetup && split.dirty ? `${split.currentSetup.name} 副本` : "");
                }}
              />
            ) : null}
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

function NoticeToast({ notice, onDismiss }: { notice: PanelNotice; onDismiss: () => void }) {
  const icon =
    notice.kind === "arranged" ? (
      <LayoutDashboard size={15} className="text-accent" />
    ) : notice.kind === "deleted" ? (
      <Trash2 size={15} className="text-live" />
    ) : notice.kind === "error" ? (
      <TriangleAlert size={15} className="text-replay" />
    ) : (
      <Check size={15} className="text-online" />
    );
  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8 }}
      transition={{ duration: 0.16 }}
      className="pointer-events-auto flex items-center gap-2.5 rounded-full border border-line-strong bg-elevated py-1.5 pr-1.5 pl-3.5 text-xs font-semibold text-fg shadow-float"
    >
      {icon}
      {notice.message}
      {notice.undo ? (
        <button
          type="button"
          onClick={() => {
            notice.undo?.();
            onDismiss();
          }}
          className="rounded-full bg-chip px-3 py-1 font-bold text-accent hover:bg-hover"
        >
          撤销
        </button>
      ) : (
        <span className="w-1.5" />
      )}
    </m.div>
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
