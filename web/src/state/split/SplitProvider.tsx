// Split view: several rooms on one grid (1×2 up to 4×4), tiles spanning any
// rectangle of cells. Geometry lives in ./layout; this holds the state, the
// actions and persistence. Each tile plays through services/roomSession, so
// rooms run side by side on the backend's per-room proxy and danmaku.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import type { RoomRef } from "@/hooks/useOpenRoom";
import { captureSetup, isDirty, type SavedSetup, type SplitSnapshot } from "./setups";
import {
  PRESETS,
  applySlots,
  autoArrange,
  clampDim,
  dragMove,
  freeCells,
  gridFor,
  resizeGrid,
  resizeTile,
  swapTiles,
  type Rect,
  type Arrangement
} from "./layout";

export interface SplitTile {
  id: string;
  room: RoomRef;
  rect: Rect;
}

interface SplitState {
  open: boolean;
  cols: number;
  rows: number;
  tiles: SplitTile[];
  /** The tile whose audio plays (and whose danmaku shows unless danmakuAll). */
  focusId: string | null;
  /** Shown full-grid on its own ("maximize"); the others keep running underneath. */
  zoomId: string | null;
  layoutName: string;
  danmakuAll: boolean;
  audioFollowsClick: boolean;
  /** The saved setup this view was opened from or last saved as. */
  setupId: string | null;
}

/** Where "Add room" puts the next pick: a specific empty cell, or replacing a tile's room. */
export type PickTarget = { cell?: { col: number; row: number }; replaceTileId?: string } | null;

type SplitContextValue = SplitState & {
  picking: PickTarget;
  /** Opens split view with these rooms (keeps it open with its rooms if already open). */
  openWith: (rooms: RoomRef[]) => void;
  close: () => void;
  /** Adds a room to the next free cell (or `target`); returns false when the grid is full. */
  addRoom: (room: RoomRef, target?: PickTarget) => boolean;
  removeTile: (id: string) => void;
  focus: (id: string) => void;
  toggleZoom: (id: string) => void;
  applyPreset: (name: string) => boolean;
  setGrid: (cols: number, rows: number) => boolean;
  /** Returns false (and changes nothing) when the span can't fit. */
  spanTile: (id: string, rect: Rect) => boolean;
  previewSpan: (id: string, rect: Rect) => boolean;
  swap: (a: string, b: string) => void;
  /** Where a drag would put the tile (span kept at `topLeft`, else one cell at `pointer`); null if nowhere. */
  previewMove: (id: string, topLeft: { col: number; row: number }, pointer: { col: number; row: number }) => Rect | null;
  move: (id: string, topLeft: { col: number; row: number }, pointer: { col: number; row: number }) => boolean;
  setDanmakuAll: (v: boolean) => void;
  setAudioFollowsClick: (v: boolean) => void;
  beginPick: (target: PickTarget) => void;
  cancelPick: () => void;
  emptyCells: Rect[];
  /** What Auto Arrange would produce for a grid of this width/height ratio (null: nothing to do). */
  previewArrange: (gridAspect: number) => Arrangement<SplitTile> | null;
  /** Applies Auto Arrange; the previous layout is kept for undoLayout(). */
  arrange: (gridAspect: number) => Arrangement<SplitTile> | null;
  canUndoLayout: boolean;
  undoLayout: () => void;
  setups: SavedSetup[];
  currentSetup: SavedSetup | null;
  /** The view differs from the setup it came from. */
  dirty: boolean;
  saveSetup: (name: string, layoutOnly: boolean) => SavedSetup;
  updateSetup: (id: string) => void;
  /** "too-small": a layout-only setup with fewer cells than open rooms. */
  openSetup: (id: string) => "ok" | "too-small" | "missing";
  renameSetup: (id: string, name: string) => void;
  duplicateSetup: (id: string) => SavedSetup | null;
  /** Returns an undo that puts it back where it was. */
  deleteSetup: (id: string) => (() => void) | null;
};

const STORAGE_KEY = "livedeck_split_v1";
const SETUPS_KEY = "livedeck_split_setups_v1";
const sameRoom = (a: RoomRef, b: RoomRef) => a.platform === b.platform && a.roomId === b.roomId;

const INITIAL: SplitState = {
  open: false,
  cols: 2,
  rows: 1,
  tiles: [],
  focusId: null,
  zoomId: null,
  layoutName: "1 × 2",
  danmakuAll: false,
  audioFollowsClick: true,
  setupId: null
};

function gridName(cols: number, rows: number) {
  return `${rows} × ${cols}`;
}

type Grid = { cols: number; rows: number; tiles: SplitTile[] };

/** Puts a room in `cell` if free, else the first free cell, growing the grid (up to 4×4) when full. */
function placeRoom(grid: Grid, room: RoomRef, cell?: { col: number; row: number }): (Grid & { tile: SplitTile }) | null {
  let { cols, rows, tiles } = grid;
  let free = freeCells(tiles, cols, rows);
  if (!free.length) {
    if (cols * rows >= 16) return null;
    const next = gridFor(cols * rows + 1);
    const grown = resizeGrid(tiles, next.cols, next.rows);
    if (!grown) return null;
    ({ cols, rows } = next);
    tiles = grown;
    free = freeCells(tiles, cols, rows);
  }
  const rect = (cell && free.find((c) => c.col === cell.col && c.row === cell.row)) || free[0];
  const tile: SplitTile = { id: uuidv4(), room, rect: { ...rect } };
  return { cols, rows, tiles: [...tiles, tile], tile };
}

const SplitContext = createContext<SplitContextValue | null>(null);

export function SplitProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SplitState>(INITIAL);
  const [picking, setPicking] = useState<PickTarget>(null);
  const [setups, setSetups] = useState<SavedSetup[]>([]);
  const [layoutUndo, setLayoutUndo] = useState<Pick<SplitState, "cols" | "rows" | "tiles" | "layoutName"> | null>(null);
  const hydrated = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Restore the last layout and rooms, closed: reopening shouldn't start N streams at launch.
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && Array.isArray(saved.tiles)) setState({ ...INITIAL, ...saved, open: false, zoomId: null });
      const savedSetups = JSON.parse(window.localStorage.getItem(SETUPS_KEY) || "null");
      if (Array.isArray(savedSetups)) setSetups(savedSetups);
    } catch {
      // ignore
    }
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      const { open: _open, zoomId: _zoom, ...persist } = state;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(persist));
    } catch {
      // ignore
    }
  }, [state]);

  useEffect(() => {
    if (!hydrated.current) return;
    try {
      window.localStorage.setItem(SETUPS_KEY, JSON.stringify(setups));
    } catch {
      // ignore
    }
  }, [setups]);

  // Any layout change other than Auto Arrange makes its undo stale.
  const layoutKey = `${state.cols}x${state.rows}:${state.tiles.map((t) => `${t.id}${t.rect.col}${t.rect.row}${t.rect.colSpan}${t.rect.rowSpan}`).join()}`;
  const arrangedKey = useRef<string | null>(null);
  useEffect(() => {
    if (layoutUndo && arrangedKey.current !== layoutKey) setLayoutUndo(null);
  }, [layoutKey, layoutUndo]);

  const openWith = useCallback((rooms: RoomRef[]) => {
    setState((s) => {
      let grid = { cols: s.cols, rows: s.rows, tiles: s.tiles };
      let focusId = s.focusId;
      for (const room of rooms) {
        const existing = grid.tiles.find((t) => sameRoom(t.room, room));
        if (existing) {
          focusId = existing.id;
          continue;
        }
        const placed = placeRoom(grid, room);
        if (!placed) break;
        grid = placed;
        focusId = placed.tile.id;
      }
      const resized = grid.cols !== s.cols || grid.rows !== s.rows;
      return { ...s, ...grid, open: true, focusId: focusId ?? grid.tiles[0]?.id ?? null, layoutName: resized ? gridName(grid.cols, grid.rows) : s.layoutName };
    });
  }, []);

  const close = useCallback(() => {
    setPicking(null);
    setState((s) => ({ ...s, open: false, zoomId: null }));
  }, []);

  const addRoom = useCallback((room: RoomRef, target?: PickTarget) => {
    const s = stateRef.current;
    const existing = s.tiles.find((t) => sameRoom(t.room, room));
    if (existing) {
      setState((cur) => ({ ...cur, focusId: existing.id }));
      return true;
    }
    if (target?.replaceTileId) {
      setState((cur) => ({ ...cur, tiles: cur.tiles.map((t) => (t.id === target.replaceTileId ? { ...t, room } : t)) }));
      return true;
    }
    const placed = placeRoom(s, room, target?.cell);
    if (!placed) return false;
    setState((cur) => ({
      ...cur,
      cols: placed.cols,
      rows: placed.rows,
      tiles: placed.tiles,
      layoutName: placed.cols === cur.cols && placed.rows === cur.rows ? cur.layoutName : gridName(placed.cols, placed.rows),
      focusId: cur.focusId ?? placed.tile.id
    }));
    return true;
  }, []);

  const removeTile = useCallback((id: string) => {
    setState((s) => {
      const tiles = s.tiles.filter((t) => t.id !== id);
      return {
        ...s,
        tiles,
        focusId: s.focusId === id ? tiles[0]?.id ?? null : s.focusId,
        zoomId: s.zoomId === id ? null : s.zoomId
      };
    });
  }, []);

  const focus = useCallback((id: string) => setState((s) => (s.focusId === id ? s : { ...s, focusId: id })), []);
  const toggleZoom = useCallback((id: string) => setState((s) => ({ ...s, zoomId: s.zoomId === id ? null : id, focusId: id })), []);

  const applyPreset = useCallback((name: string) => {
    const preset = PRESETS.find((p) => p.name === name);
    if (!preset) return false;
    const placed = applySlots(stateRef.current.tiles, preset.slots);
    if (!placed) return false;
    setState((s) => ({ ...s, cols: preset.cols, rows: preset.rows, tiles: placed, layoutName: preset.name, zoomId: null }));
    return true;
  }, []);

  const setGrid = useCallback((c: number, r: number) => {
    const cols = clampDim(c);
    const rows = clampDim(r);
    const placed = resizeGrid(stateRef.current.tiles, cols, rows);
    if (!placed) return false;
    setState((s) => ({ ...s, cols, rows, tiles: placed, layoutName: gridName(cols, rows), zoomId: null }));
    return true;
  }, []);

  const previewSpan = useCallback((id: string, rect: Rect) => {
    const s = stateRef.current;
    return !!resizeTile(s.tiles, id, rect, s.cols, s.rows);
  }, []);

  const spanTile = useCallback((id: string, rect: Rect) => {
    const s = stateRef.current;
    const next = resizeTile(s.tiles, id, rect, s.cols, s.rows);
    if (!next) return false;
    setState((cur) => ({ ...cur, tiles: next, layoutName: "Custom" }));
    return true;
  }, []);

  const swap = useCallback((a: string, b: string) => {
    setState((s) => ({ ...s, tiles: swapTiles(s.tiles, a, b), layoutName: "Custom" }));
  }, []);

  const previewMove = useCallback((id: string, topLeft: { col: number; row: number }, pointer: { col: number; row: number }) => {
    const s = stateRef.current;
    return dragMove(s.tiles, id, topLeft, pointer, s.cols, s.rows)?.find((t) => t.id === id)?.rect ?? null;
  }, []);

  const move = useCallback((id: string, topLeft: { col: number; row: number }, pointer: { col: number; row: number }) => {
    const s = stateRef.current;
    const next = dragMove(s.tiles, id, topLeft, pointer, s.cols, s.rows);
    if (!next) return false;
    setState((cur) => ({ ...cur, tiles: next, layoutName: "Custom" }));
    return true;
  }, []);

  const setDanmakuAll = useCallback((v: boolean) => setState((s) => ({ ...s, danmakuAll: v })), []);
  const setAudioFollowsClick = useCallback((v: boolean) => setState((s) => ({ ...s, audioFollowsClick: v })), []);
  const beginPick = useCallback((target: PickTarget) => setPicking(target ?? {}), []);
  const cancelPick = useCallback(() => setPicking(null), []);

  const previewArrange = useCallback((gridAspect: number) => {
    const s = stateRef.current;
    const a = autoArrange(s.tiles, gridAspect);
    if (!a) return null;
    const same = a.cols === s.cols && a.rows === s.rows && a.tiles.every((t, i) => JSON.stringify(t.rect) === JSON.stringify(s.tiles[i].rect));
    return same ? null : a;
  }, []);

  const arrange = useCallback(
    (gridAspect: number) => {
      const s = stateRef.current;
      const a = previewArrange(gridAspect);
      if (!a) return null;
      setLayoutUndo({ cols: s.cols, rows: s.rows, tiles: s.tiles, layoutName: s.layoutName });
      arrangedKey.current = `${a.cols}x${a.rows}:${a.tiles.map((t) => `${t.id}${t.rect.col}${t.rect.row}${t.rect.colSpan}${t.rect.rowSpan}`).join()}`;
      setState((cur) => ({ ...cur, cols: a.cols, rows: a.rows, tiles: a.tiles, layoutName: a.name, zoomId: null }));
      return a;
    },
    [previewArrange]
  );

  const undoLayout = useCallback(() => {
    setLayoutUndo((u) => {
      // Any change after arranging clears the undo, so this restores an untouched arrangement.
      if (u) setState((cur) => ({ ...cur, cols: u.cols, rows: u.rows, tiles: u.tiles, layoutName: u.layoutName }));
      return null;
    });
  }, []);

  const snapshot = (s: SplitState): SplitSnapshot => s;

  const saveSetup = useCallback((name: string, layoutOnly: boolean) => {
    const setup = captureSetup(snapshot(stateRef.current), uuidv4(), name.trim() || "未命名方案", layoutOnly);
    setSetups((list) => [setup, ...list]);
    setState((s) => ({ ...s, setupId: setup.id }));
    return setup;
  }, []);

  const updateSetup = useCallback((id: string) => {
    setSetups((list) => list.map((x) => (x.id === id ? captureSetup(snapshot(stateRef.current), x.id, x.name, x.layoutOnly) : x)));
    setState((s) => ({ ...s, setupId: id }));
  }, []);

  const openSetup = useCallback(
    (id: string) => {
      const setup = setups.find((x) => x.id === id);
      if (!setup) return "missing" as const;
      const s = stateRef.current;
      if (setup.layoutOnly) {
        const ordered = [...s.tiles].sort((a, b) => a.rect.row - b.rect.row || a.rect.col - b.rect.col);
        const placed = applySlots(ordered, setup.tiles.map((t) => t.rect));
        if (!placed) return "too-small" as const;
        setState((cur) => ({ ...cur, cols: setup.cols, rows: setup.rows, tiles: placed, layoutName: setup.layoutName, zoomId: null, setupId: id }));
        return "ok" as const;
      }
      // Rooms already on screen keep their tile id, so their streams keep running.
      const existing = new Map(s.tiles.map((t) => [`${t.room.platform}:${t.room.roomId}`, t.id]));
      const tiles: SplitTile[] = setup.tiles
        .filter((t): t is { room: RoomRef; rect: Rect } => !!t.room)
        .map((t) => ({ id: existing.get(`${t.room.platform}:${t.room.roomId}`) ?? uuidv4(), room: t.room, rect: { ...t.rect } }));
      const focusId = setup.focusIndex !== null ? tiles[setup.focusIndex]?.id ?? null : tiles[0]?.id ?? null;
      setState((cur) => ({
        ...cur,
        open: true,
        cols: setup.cols,
        rows: setup.rows,
        tiles,
        layoutName: setup.layoutName,
        focusId,
        zoomId: null,
        danmakuAll: setup.danmakuAll,
        audioFollowsClick: setup.audioFollowsClick,
        setupId: id
      }));
      return "ok" as const;
    },
    [setups]
  );

  const renameSetup = useCallback((id: string, name: string) => {
    const next = name.trim();
    if (!next) return;
    setSetups((list) => list.map((x) => (x.id === id ? { ...x, name: next, updatedAt: Date.now() } : x)));
  }, []);

  const duplicateSetup = useCallback(
    (id: string) => {
      const src = setups.find((x) => x.id === id);
      if (!src) return null;
      const copy: SavedSetup = { ...src, id: uuidv4(), name: `${src.name} 副本`, updatedAt: Date.now() };
      setSetups((list) => {
        const i = list.findIndex((x) => x.id === id);
        return [...list.slice(0, i + 1), copy, ...list.slice(i + 1)];
      });
      return copy;
    },
    [setups]
  );

  const deleteSetup = useCallback(
    (id: string) => {
      const index = setups.findIndex((x) => x.id === id);
      if (index < 0) return null;
      const removed = setups[index];
      const wasCurrent = stateRef.current.setupId === id;
      setSetups((list) => list.filter((x) => x.id !== id));
      // The current view stays as it is; it just isn't tied to a setup any more.
      if (wasCurrent) setState((s) => ({ ...s, setupId: null }));
      return () => {
        setSetups((list) => (list.some((x) => x.id === id) ? list : [...list.slice(0, index), removed, ...list.slice(index)]));
        if (wasCurrent) setState((s) => (s.setupId === null ? { ...s, setupId: id } : s));
      };
    },
    [setups]
  );

  const currentSetup = useMemo(() => setups.find((x) => x.id === state.setupId) ?? null, [setups, state.setupId]);
  const dirty = useMemo(() => (currentSetup ? isDirty(state, currentSetup) : false), [currentSetup, state]);

  const emptyCells = useMemo(() => freeCells(state.tiles, state.cols, state.rows), [state.cols, state.rows, state.tiles]);

  const value = useMemo<SplitContextValue>(
    () => ({
      ...state,
      picking,
      openWith,
      close,
      addRoom,
      removeTile,
      focus,
      toggleZoom,
      applyPreset,
      setGrid,
      spanTile,
      previewSpan,
      swap,
      previewMove,
      move,
      setDanmakuAll,
      setAudioFollowsClick,
      beginPick,
      cancelPick,
      emptyCells,
      previewArrange,
      arrange,
      canUndoLayout: !!layoutUndo,
      undoLayout,
      setups,
      currentSetup,
      dirty,
      saveSetup,
      updateSetup,
      openSetup,
      renameSetup,
      duplicateSetup,
      deleteSetup
    }),
    [state, picking, openWith, close, addRoom, removeTile, focus, toggleZoom, applyPreset, setGrid, spanTile, previewSpan, swap, previewMove, move, setDanmakuAll, setAudioFollowsClick, beginPick, cancelPick, emptyCells, previewArrange, arrange, layoutUndo, undoLayout, setups, currentSetup, dirty, saveSetup, updateSetup, openSetup, renameSetup, duplicateSetup, deleteSetup]
  );

  return <SplitContext.Provider value={value}>{children}</SplitContext.Provider>;
}

export function useSplit() {
  const ctx = useContext(SplitContext);
  if (!ctx) throw new Error("useSplit must be used within SplitProvider");
  return ctx;
}
